import Foundation

public struct DesktopUnreachable: Error, Sendable {
    /// The desktop record, including any newer endpoints and counter found in its mailbox.
    public let updated: PairedDesktop
    public let lastError: Error?
}

/// Dials a paired desktop: every known endpoint in order, then the iCloud mailbox for a newer
/// endpoint list, then those endpoints. Also runs first-time pairing from a QR payload.
public struct DesktopConnector: Sendable {
    public let identity: RemoteClientIdentity
    public let channelFactory: WebSocketChannelFactory
    public let mailbox: MailboxSource?
    public let attemptTimeout: Duration

    public init(
        identity: RemoteClientIdentity,
        channelFactory: @escaping WebSocketChannelFactory = { URLSessionWebSocketChannel(url: $0) },
        mailbox: MailboxSource? = nil,
        attemptTimeout: Duration = .seconds(8)
    ) {
        self.identity = identity
        self.channelFactory = channelFactory
        self.mailbox = mailbox
        self.attemptTimeout = attemptTimeout
    }

    public func connect(_ desktop: PairedDesktop) async throws -> (RemoteClient, PairedDesktop) {
        var current = desktop
        var lastError: Error?
        if let client = try await dial(current.endpoints, desktopKey: current.desktopKey, lastError: &lastError) {
            return (client, current)
        }
        try Task.checkCancellation()
        guard let mailbox,
              let keys = try? Mailbox.deriveKeys(secret: current.mailboxSecret),
              let box = try await mailbox.read(mailboxId: keys.mailboxId),
              let plaintext = try? Mailbox.open(box: box, key: keys.mailboxKey, lastCounter: current.mailboxCounter),
              plaintext.remoteDeviceId == current.remoteDeviceId
        else { throw DesktopUnreachable(updated: current, lastError: lastError) }
        // The box is authenticated with the pairing's mailbox key; the Noise handshake below still
        // proves the desktop's identity, so a forged address can only make this attempt fail.
        current.mailboxCounter = plaintext.counter
        current.endpoints = plaintext.endpoints.map(StoredEndpoint.init)
        if let client = try await dial(current.endpoints, desktopKey: current.desktopKey, lastError: &lastError) {
            return (client, current)
        }
        throw DesktopUnreachable(updated: current, lastError: lastError)
    }

    /// Pairs with the desktop in a QR payload and completes `remote.hello`.
    public func pair(_ payload: RemotePairingPayload) async throws -> (RemoteClient, PairedDesktop, RemoteHelloOutput) {
        guard let desktopKey = Base64URL.decode(payload.desktopKey), let token = Base64URL.decode(payload.token) else {
            throw PairingURLError.malformedPayload
        }
        var lastError: Error?
        for endpoint in payload.endpoints {
            guard let url = URL(string: endpoint.url) else { continue }
            do {
                let client = try await withTimeout {
                    try await RemoteClient.pair(endpoint: url, desktopKey: desktopKey, token: token, identity: identity, channelFactory: channelFactory)
                }
                let hello: RemoteHelloOutput = try await client.call("remote.hello", HelloInput.current)
                let grant = try await client.pairingGrant()
                let desktop = PairedDesktop(
                    remoteDeviceId: payload.remoteDeviceId,
                    pairingId: grant.pairingId,
                    deviceName: hello.deviceName,
                    desktopKey: desktopKey,
                    mailboxSecret: grant.mailboxSecret,
                    endpoints: payload.endpoints.map(StoredEndpoint.init),
                    syncDeviceId: hello.syncDeviceId,
                    cursor: nil
                )
                return (client, desktop, hello)
            } catch {
                lastError = error
            }
        }
        throw lastError ?? PairingURLError.malformedPayload
    }

    private func dial(_ endpoints: [StoredEndpoint], desktopKey: Data, lastError: inout Error?) async throws -> RemoteClient? {
        for endpoint in endpoints {
            try Task.checkCancellation()
            guard let url = URL(string: endpoint.url) else { continue }
            do {
                return try await withTimeout {
                    try await RemoteClient.connect(endpoint: url, desktopKey: desktopKey, identity: identity, channelFactory: channelFactory)
                }
            } catch {
                try Task.checkCancellation()
                lastError = error
            }
        }
        return nil
    }

    private func withTimeout<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: attemptTimeout)
                throw URLError(.timedOut)
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }
}

/// `remote.hello` input for this client.
public struct HelloInput: Encodable, Sendable {
    public let protocolVersion: Int
    public let client: Client

    public struct Client: Encodable, Sendable {
        public let app: String
        public let version: String
    }

    public static let current = HelloInput(
        protocolVersion: remoteProtocolVersion,
        client: Client(app: "yachiyo-ios", version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")
    )
}
