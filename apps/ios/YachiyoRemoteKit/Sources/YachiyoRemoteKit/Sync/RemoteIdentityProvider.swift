import Foundation

/// The phone's handshake identity, with the static key loaded lazily on a background queue:
/// the Keychain read (`SecItemCopyMatching`) blocks, so it must not run on the main thread or
/// occupy a cooperative-pool thread. A successful load is cached; a failed one is retried by
/// the next dial.
public final class RemoteIdentityProvider: @unchecked Sendable {
    private static let queue = DispatchQueue(label: "sh.ringo.yachiyo.remote.identity", qos: .userInitiated)

    private let deviceName: String
    private let appVersion: String
    private let loadStaticKey: @Sendable () throws -> Data
    private let lock = NSLock()
    private var cached: RemoteClientIdentity?

    public init(deviceName: String, appVersion: String, loadStaticKey: @escaping @Sendable () throws -> Data) {
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.loadStaticKey = loadStaticKey
    }

    /// An identity that is already in memory.
    public convenience init(_ identity: RemoteClientIdentity) {
        self.init(deviceName: identity.deviceName, appVersion: identity.appVersion, loadStaticKey: { identity.staticPrivateKey })
        cached = identity
    }

    public func identity() async throws -> RemoteClientIdentity {
        if let cached = lock.withLock({ cached }) { return cached }
        return try await withCheckedThrowingContinuation { continuation in
            Self.queue.async { [self] in
                continuation.resume(with: Result { try loadNow() })
            }
        }
    }

    /// Starts loading without waiting, e.g. while the cache is read at launch.
    public func prefetch() {
        Self.queue.async { [self] in _ = try? loadNow() }
    }

    private func loadNow() throws -> RemoteClientIdentity {
        if let cached = lock.withLock({ cached }) { return cached }
        let identity = RemoteClientIdentity(staticPrivateKey: try loadStaticKey(), deviceName: deviceName, appVersion: appVersion)
        lock.withLock { cached = identity }
        return identity
    }
}
