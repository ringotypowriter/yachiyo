import UIKit
import UserNotifications

@MainActor
final class PushNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotifications()
    private var checkingPermission = false
    private var allowsAlerts = false
    private var token: String?
    private var pendingTap: [AnyHashable: Any]?

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func refreshPermission(promptIfNeeded: Bool) {
        guard RemoteStore.shared.hasDesktops, !checkingPermission else { return }
        checkingPermission = true
        Task {
            defer { checkingPermission = false }
            let center = UNUserNotificationCenter.current()
            var status = await center.notificationSettings().authorizationStatus
            if status == .notDetermined, promptIfNeeded {
                _ = try? await center.requestAuthorization(options: [.alert, .sound])
                status = await center.notificationSettings().authorizationStatus
            }
            guard RemoteStore.shared.hasDesktops else { return }
            switch status {
            case .denied:
                allowsAlerts = false
                token = nil
                RemoteStore.shared.updatePushToken(.denied)
            case .authorized, .provisional, .ephemeral:
                allowsAlerts = true
                // APNs may rotate this on any launch. Never use a saved token in its place.
                if let token { RemoteStore.shared.updatePushToken(.value(token)) }
                UIApplication.shared.registerForRemoteNotifications()
            case .notDetermined:
                break
            @unknown default:
                break
            }
        }
    }

    func receivedDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard token.count == 64 else { return }
        self.token = token
        if allowsAlerts { RemoteStore.shared.updatePushToken(.value(token)) }
    }

    func receiveTap(_ userInfo: [AnyHashable: Any]) {
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0.delegate as? SceneDelegate }).first {
            scene.handleNotification(userInfo)
        } else {
            pendingTap = userInfo
        }
    }

    func takePendingTap() -> [AnyHashable: Any]? {
        defer { pendingTap = nil }
        return pendingTap
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The foreground inbox/thread updates via the encrypted event stream instead.
        completionHandler([])
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor in
            receiveTap(userInfo)
            completionHandler()
        }
    }
}
