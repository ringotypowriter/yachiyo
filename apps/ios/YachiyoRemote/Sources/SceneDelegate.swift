import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var coordinator: AppCoordinator?
    private var cacheBackgroundTasks: [UUID: UIBackgroundTaskIdentifier] = [:]

    func scene(
        _ scene: UIScene,
        willConnectTo _: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let coordinator = AppCoordinator(window: window)
        self.window = window
        self.coordinator = coordinator
        coordinator.start(initialURL: connectionOptions.urlContexts.first?.url)
        if let response = connectionOptions.notificationResponse {
            coordinator.handleNotification(response.notification.request.content.userInfo)
        } else if let pending = PushNotifications.shared.takePendingTap() {
            coordinator.handleNotification(pending)
        }
    }

    func scene(_: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        guard let url = contexts.first?.url else { return }
        coordinator?.handle(url: url)
    }

    func sceneWillEnterForeground(_: UIScene) {
        RemoteStore.shared.resume()
        PushNotifications.shared.refreshPermission(promptIfNeeded: false)
    }

    func handleNotification(_ userInfo: [AnyHashable: Any]) {
        coordinator?.handleNotification(userInfo)
    }

    func sceneDidEnterBackground(_: UIScene) {
        // iOS drops sockets in the background; close cleanly and resume from the cursor later.
        let token = UUID()
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save remote snapshots") { [weak self] in
            self?.finishCacheBackgroundTask(token)
        }
        if task != .invalid { cacheBackgroundTasks[token] = task }
        RemoteStore.shared.suspend { [weak self] in self?.finishCacheBackgroundTask(token) }
    }

    private func finishCacheBackgroundTask(_ token: UUID) {
        guard let task = cacheBackgroundTasks.removeValue(forKey: token) else { return }
        UIApplication.shared.endBackgroundTask(task)
    }
}

/// Owns the window's navigation: the inbox, pairing, and routes from deep links or launch
/// arguments (`-YachiyoRoute thread-first` or `thread:<id>` for screenshots).
@MainActor
final class AppCoordinator {
    private let window: UIWindow
    private let navigation: UINavigationController
    private let inbox: InboxViewController
    private var isBootstrapping = false
    private var pendingURL: URL?
    private var pendingNotification: [AnyHashable: Any]?

    init(window: UIWindow) {
        self.window = window
        inbox = InboxViewController()
        navigation = UINavigationController(rootViewController: inbox)
        navigation.navigationBar.prefersLargeTitles = true
        navigation.setToolbarHidden(false, animated: false)
    }

    func start(initialURL: URL? = nil) {
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        ThemeController.shared.apply()
        isBootstrapping = true
        RemoteStore.shared.bootstrap { [weak self] in
            self?.finishStart(initialURL: initialURL)
        }
    }

    private func finishStart(initialURL: URL?) {
        isBootstrapping = false
        PushNotifications.shared.refreshPermission(promptIfNeeded: RemoteStore.shared.hasDesktops)
        if let pendingNotification {
            self.pendingNotification = nil
            // Validation happens only after the Keychain has loaded the paired identities.
            if routeNotification(pendingNotification) { return }
        }
        let initialURL = pendingURL ?? initialURL
        pendingURL = nil
        if let initialURL, initialURL.scheme == PairingURL.scheme {
            DispatchQueue.main.async { self.handle(url: initialURL) }
            return
        }
        #if DEBUG
        // `-YachiyoPairingURL <url>` pairs like the deep link, without the system's
        // "Open in Yachiyo?" prompt that `simctl openurl` triggers (automation only).
        if let raw = UserDefaults.standard.string(forKey: "YachiyoPairingURL"), let url = URL(string: raw) {
            DispatchQueue.main.async { self.handle(url: url) }
            return
        }
        #endif
        if let route = UserDefaults.standard.string(forKey: "YachiyoRoute") {
            inbox.pendingRoute = route
        } else if !RemoteStore.shared.hasDesktops {
            DispatchQueue.main.async { self.presentPairing(url: nil) }
        }
    }

    func handle(url: URL) {
        guard url.scheme == PairingURL.scheme else { return }
        if isBootstrapping {
            pendingURL = url
            return
        }
        presentPairing(url: url)
    }

    func handleNotification(_ userInfo: [AnyHashable: Any]) {
        if isBootstrapping {
            pendingNotification = userInfo
            return
        }
        _ = routeNotification(userInfo)
    }

    @discardableResult
    private func routeNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let route = NotificationThreadRoute(
            userInfo: userInfo,
            pairedDesktopIds: Set(RemoteStore.shared.desktops.map(\.id))
        ) else { return false }
        if let thread = navigation.topViewController as? ThreadViewController,
           thread.notificationRoute == route { return true }
        let show = {
            self.navigation.popToRootViewController(animated: false)
            self.navigation.pushViewController(
                ThreadViewController(desktopId: route.desktopId, threadId: route.threadId),
                animated: true
            )
        }
        if navigation.presentedViewController != nil {
            navigation.dismiss(animated: false, completion: show)
        } else {
            show()
        }
        return true
    }

    func presentPairing(url: URL?) {
        let pairing = PairingViewController(initialURL: url)
        pairing.onFinished = { [weak self] in self?.navigation.dismiss(animated: true) }
        let container = UINavigationController(rootViewController: pairing)
        container.modalPresentationStyle = .fullScreen
        if let presented = navigation.presentedViewController {
            presented.dismiss(animated: false) { self.navigation.present(container, animated: true) }
        } else {
            navigation.present(container, animated: true)
        }
    }
}
