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

    public enum Progress: Sendable {
        case attempting(String)
        case connected(String)
        case recovery(AddressRecoveryStatus, PairedDesktop)
    }
    public typealias Observer = @Sendable (Progress) async -> Void

    public func recover(_ desktop: PairedDesktop) async -> (PairedDesktop, AddressRecoveryStatus) {
        func status(_ outcome: AddressRecoveryOutcome, _ detail: String? = nil) -> AddressRecoveryStatus {
            AddressRecoveryStatus(outcome: outcome, checkedAt: Date(), detail: detail)
        }
        guard let mailbox else { return (desktop, status(.notConfigured)) }
        do {
            let keys = try Mailbox.deriveKeys(secret: desktop.mailboxSecret)
            guard let box = try await mailbox.read(mailboxId: keys.mailboxId) else { return (desktop, status(.notFound, "The mailbox file was not found in the selected folder.")) }
            let plaintext = try Mailbox.open(box: box, key: keys.mailboxKey, lastCounter: desktop.mailboxCounter)
            guard plaintext.remoteDeviceId == desktop.remoteDeviceId else { return (desktop, status(.failed, "Mailbox device identity does not match this pairing.")) }
            var updated = desktop
            updated.mailboxCounter = plaintext.counter
            updated.endpoints = plaintext.endpoints.map(StoredEndpoint.init)
            let changed = updated.endpoints != desktop.endpoints
            if changed {
                updated.lastAddressUpdateAt = Date()
                updated.lastAddressUpdateURL = updated.endpoints.first?.url
            }
            return (updated, status(changed ? .updated : .unchanged))
        } catch MailboxReadError.notConfigured {
            return (desktop, status(.notConfigured))
        } catch MailboxReadError.staleBookmark {
            return (desktop, status(.failed, "Folder permission is stale. Select the Yachiyo folder again."))
        } catch MailboxReadError.accessDenied {
            return (desktop, status(.failed, "Access to the selected folder was denied. Select it again."))
        } catch MailboxError.rolledBack {
            return (desktop, status(.unchanged, "No newer mailbox update; the stale or already accepted counter was rejected."))
        } catch {
            let error = error as NSError
            let detail = error.domain == NSCocoaErrorDomain
                ? "The mailbox file could not be read. Check folder access and iCloud download status."
                : "Mailbox authentication or format does not match this pairing."
            return (desktop, status(.failed, detail))
        }
    }

    public func connect(_ desktop: PairedDesktop, recoverUsing: (@Sendable (PairedDesktop) async -> (PairedDesktop, AddressRecoveryStatus))? = nil, observe: Observer? = nil) async throws -> (RemoteClient, PairedDesktop) {
        var lastError: Error?
        if let client = try await dial(desktop.endpoints, desktopKey: desktop.desktopKey, lastError: &lastError, observe: observe) {
            return (client, desktop)
        }
        try Task.checkCancellation()
        await observe?(.recovery(AddressRecoveryStatus(outcome: .checking), desktop))
        let (updated, status): (PairedDesktop, AddressRecoveryStatus)
        if let recoverUsing { (updated, status) = await recoverUsing(desktop) }
        else { (updated, status) = await recover(desktop) }
        try Task.checkCancellation()
        // Publish and persist accepted mailbox data before potentially slow endpoint attempts.
        await observe?(.recovery(status, updated))
        if updated.endpoints != desktop.endpoints,
           let client = try await dial(updated.endpoints, desktopKey: updated.desktopKey, lastError: &lastError, observe: observe) {
            return (client, updated)
        }
        throw DesktopUnreachable(updated: updated, lastError: lastError)
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
                var desktop = PairedDesktop(
                    remoteDeviceId: payload.remoteDeviceId,
                    pairingId: grant.pairingId,
                    deviceName: hello.deviceName,
                    desktopKey: desktopKey,
                    mailboxSecret: grant.mailboxSecret,
                    endpoints: payload.endpoints.map(StoredEndpoint.init),
                    syncDeviceId: hello.syncDeviceId,
                    cursor: nil
                )
                desktop.lastSuccessfulURL = url.absoluteString
                return (client, desktop, hello)
            } catch {
                lastError = error
            }
        }
        throw lastError ?? PairingURLError.malformedPayload
    }

    private func dial(_ endpoints: [StoredEndpoint], desktopKey: Data, lastError: inout Error?, observe: Observer?) async throws -> RemoteClient? {
        for endpoint in endpoints {
            try Task.checkCancellation()
            guard let url = URL(string: endpoint.url) else { continue }
            await observe?(.attempting(url.absoluteString))
            do {
                let client = try await withTimeout {
                    try await RemoteClient.connect(endpoint: url, desktopKey: desktopKey, identity: identity, channelFactory: channelFactory)
                }
                await observe?(.connected(url.absoluteString))
                return client
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
