import Foundation

/// No token is sent until the permission outcome is known. A denied permission explicitly
/// clears any token previously registered with the Mac.
enum PushToken: Equatable {
    case unknown
    case denied
    case value(String)

    var rpcToken: String? {
        if case let .value(token) = self { return token }
        return nil
    }
}

/// One attempt per token and encrypted connection. An older desktop that rejects the method
/// stays usable; a newly established connection may support it after the desktop is updated.
struct PushRegistrationPlan {
    private struct Attempt {
        let connection: UUID
        var token: PushToken
        var unsupported = false
    }

    private var attempts: [String: Attempt] = [:]

    mutating func begin(desktopId: String, connection: UUID, token: PushToken) -> Bool {
        guard token != .unknown else { return false }
        if let attempt = attempts[desktopId], attempt.connection == connection {
            guard !attempt.unsupported, attempt.token != token else { return false }
        }
        attempts[desktopId] = Attempt(connection: connection, token: token)
        return true
    }

    mutating func unsupported(desktopId: String, connection: UUID) {
        guard attempts[desktopId]?.connection == connection else { return }
        attempts[desktopId]?.unsupported = true
    }

    mutating func forget(desktopId: String) { attempts[desktopId] = nil }
}

struct NotificationThreadRoute: Equatable {
    let desktopId: String
    let threadId: String

    init?(userInfo: [AnyHashable: Any], pairedDesktopIds: Set<String>) {
        guard let desktopId = userInfo["remoteDeviceId"] as? String, !desktopId.isEmpty,
              let threadId = userInfo["threadId"] as? String, !threadId.isEmpty,
              pairedDesktopIds.contains(desktopId) else { return nil }
        self.desktopId = desktopId
        self.threadId = threadId
    }

    init(desktopId: String, threadId: String) {
        self.desktopId = desktopId
        self.threadId = threadId
    }
}
