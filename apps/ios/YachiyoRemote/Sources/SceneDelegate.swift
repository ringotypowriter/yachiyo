import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var coordinator: AppCoordinator?

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
    }

    func scene(_: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        guard let url = contexts.first?.url else { return }
        coordinator?.handle(url: url)
    }

    func sceneWillEnterForeground(_: UIScene) {
        RemoteStore.shared.resume()
    }

    func sceneDidEnterBackground(_: UIScene) {
        // iOS drops sockets in the background; close cleanly and resume from the cursor later.
        RemoteStore.shared.suspend()
    }
}

/// Owns the window's navigation: the inbox, pairing, and routes from deep links or launch
/// arguments (`-YachiyoRoute thread-first` or `thread:<id>` for screenshots).
@MainActor
final class AppCoordinator {
    private let window: UIWindow
    private let navigation: UINavigationController
    private let inbox: InboxViewController

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
        RemoteStore.shared.bootstrap()
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
        presentPairing(url: url)
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
