import Foundation

public struct DesktopUnreachable: Error, Sendable {
    /// The desktop record, including any newer endpoints and counter found in its mailbox.
    public let updated: PairedDesktop
    public let lastError: Error?
}

/// Dials a paired desktop: its endpoints raced happy-eyeballs style (the last one that worked
/// first), with the iCloud mailbox read alongside for a newer endpoint list, whose new
/// endpoints join the race. Also runs first-time pairing from a QR payload.
public struct DesktopConnector: Sendable {
    public let identityProvider: RemoteIdentityProvider
    public let channelFactory: WebSocketChannelFactory
    public let mailbox: MailboxSource?
    public let attemptTimeout: Duration
    /// How long an attempt runs alone before the next endpoint is dialed too.
    public let staggerDelay: Duration

    public init(
        identity: RemoteClientIdentity,
        channelFactory: @escaping WebSocketChannelFactory = { URLSessionWebSocketChannel(url: $0) },
        mailbox: MailboxSource? = nil,
        attemptTimeout: Duration = .seconds(8),
        staggerDelay: Duration = .milliseconds(250)
    ) {
        self.init(identityProvider: RemoteIdentityProvider(identity), channelFactory: channelFactory, mailbox: mailbox,
                  attemptTimeout: attemptTimeout, staggerDelay: staggerDelay)
    }

    /// Use this when the static key still has to come from the Keychain: it is loaded off the
    /// caller's thread on the first dial.
    public init(
        identityProvider: RemoteIdentityProvider,
        channelFactory: @escaping WebSocketChannelFactory = { URLSessionWebSocketChannel(url: $0) },
        mailbox: MailboxSource? = nil,
        attemptTimeout: Duration = .seconds(8),
        staggerDelay: Duration = .milliseconds(250)
    ) {
        self.identityProvider = identityProvider
        self.channelFactory = channelFactory
        self.mailbox = mailbox
        self.attemptTimeout = attemptTimeout
        self.staggerDelay = staggerDelay
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
        } catch MailboxReadError.timedOut {
            return (desktop, status(.failed, "The mailbox file did not become readable in time. Check iCloud download status."))
        } catch is CancellationError {
            return (desktop, status(.failed))
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

    /// Endpoint order for a dial: the last endpoint that worked, then the desktop's order.
    static func dialOrder(_ desktop: PairedDesktop) -> [String] {
        let urls = desktop.endpoints.map(\.url)
        guard let preferred = desktop.lastSuccessfulURL, urls.contains(preferred) else { return urls }
        return [preferred] + urls.filter { $0 != preferred }
    }

    /// Races the endpoints and keeps the first whose Noise handshake completes; the others are
    /// cancelled or closed. The mailbox read starts once the first attempt has not connected
    /// within `staggerDelay` (or failed), so a fast LAN connect never touches iCloud. A newer
    /// endpoint list is reported through `observe` before its endpoints are dialed.
    public func connect(_ desktop: PairedDesktop, recoverUsing: (@Sendable (PairedDesktop) async -> (PairedDesktop, AddressRecoveryStatus))? = nil, observe: Observer? = nil) async throws -> (RemoteClient, PairedDesktop) {
        try Task.checkCancellation()
        let identity = try await identityProvider.identity()
        let recover: @Sendable (PairedDesktop) async -> (PairedDesktop, AddressRecoveryStatus) = recoverUsing ?? { await self.recover($0) }
        let desktopKey = desktop.desktopKey
        let channelFactory = channelFactory
        let staggerDelay = staggerDelay

        enum Outcome: Sendable {
            case connected(RemoteClient, String)
            case failed(Error)
            case stagger(Int)
            case recovered(PairedDesktop, AddressRecoveryStatus)
            /// The caller was cancelled before the mailbox read finished.
            case recoveryAbandoned
        }

        return try await withThrowingTaskGroup(of: Outcome.self) { group in
            var current = desktop
            var queue = Self.dialOrder(desktop)
            var attempted = Set<String>()
            var inFlight = 0
            var staggerId = 0
            var recoveryStarted = false
            var recoveryDone = false
            var recoveryStatus: AddressRecoveryStatus?
            var recoveryReported = false
            var checkingReported = false
            var lastError: Error?

            func startRecovery() {
                guard !recoveryStarted else { return }
                recoveryStarted = true
                let original = desktop
                group.addTask {
                    guard let (updated, status) = await Self.abandoningOnCancel({ await recover(original) }) else { return .recoveryAbandoned }
                    return .recovered(updated, status)
                }
            }

            func startNext() async -> Bool {
                while !queue.isEmpty {
                    let candidate = queue.removeFirst()
                    guard attempted.insert(candidate).inserted, let url = URL(string: candidate) else { continue }
                    await observe?(.attempting(url.absoluteString))
                    inFlight += 1
                    group.addTask {
                        do {
                            let client = try await withTimeout {
                                try await RemoteClient.connect(endpoint: url, desktopKey: desktopKey, identity: identity, channelFactory: channelFactory)
                            }
                            return .connected(client, url.absoluteString)
                        } catch {
                            return .failed(error)
                        }
                    }
                    staggerId += 1
                    let id = staggerId
                    group.addTask {
                        try? await Task.sleep(for: staggerDelay)
                        return .stagger(id)
                    }
                    return true
                }
                return false
            }

            /// Cancels what is still running; a handshake that completed anyway is closed.
            func drain() async {
                group.cancelAll()
                while let outcome = try? await group.next() {
                    if case let .connected(client, _) = outcome { client.close() }
                }
            }

            if !(await startNext()) { startRecovery() }
            while let outcome = try await group.next() {
                if Task.isCancelled {
                    if case let .connected(client, _) = outcome { client.close() }
                    await drain()
                    throw CancellationError()
                }
                switch outcome {
                case let .connected(client, url):
                    await drain()
                    await observe?(.connected(url))
                    return (client, current)
                case let .failed(error):
                    inFlight -= 1
                    lastError = error
                    startRecovery()
                    _ = await startNext()
                case let .stagger(id):
                    guard id == staggerId else { break }
                    startRecovery()
                    _ = await startNext()
                case let .recovered(updated, status):
                    recoveryDone = true
                    recoveryStatus = status
                    let changed = updated.endpoints != current.endpoints
                    // Accepted mailbox data (a newer counter) is kept even when the endpoints match.
                    current = updated
                    if changed {
                        // Publish and persist before the new endpoints are dialed.
                        recoveryReported = true
                        await observe?(.recovery(status, updated))
                        let fresh = updated.endpoints.map(\.url).filter { !attempted.contains($0) }
                        queue = fresh + queue.filter { !fresh.contains($0) }
                        if !fresh.isEmpty { _ = await startNext() }
                    }
                case .recoveryAbandoned:
                    recoveryDone = true
                }
                guard inFlight == 0, queue.isEmpty else { continue }
                if !recoveryStarted { startRecovery() }
                if !recoveryDone {
                    if !checkingReported {
                        checkingReported = true
                        await observe?(.recovery(AddressRecoveryStatus(outcome: .checking), current))
                    }
                    continue
                }
                if !recoveryReported, let recoveryStatus {
                    // The read finished during the race without new endpoints.
                    recoveryReported = true
                    if !checkingReported { await observe?(.recovery(AddressRecoveryStatus(outcome: .checking), current)) }
                    await observe?(.recovery(recoveryStatus, current))
                }
                await drain()
                throw DesktopUnreachable(updated: current, lastError: lastError)
            }
            throw DesktopUnreachable(updated: current, lastError: lastError)
        }
    }

    /// Waits for `operation` unless the caller is cancelled first. The operation itself may be
    /// shared (a manual recovery check) and is left to finish on its own.
    static func abandoningOnCancel<T: Sendable>(_ operation: @escaping @Sendable () async -> T) async -> T? {
        let task = Task { await operation() }
        let box = ResumeOnce<T?>()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                box.install(continuation)
                Task { box.resume(await task.value) }
            }
        } onCancel: {
            task.cancel()
            box.resume(nil)
        }
    }

    /// Pairs with the desktop in a QR payload and completes `remote.hello`.
    public func pair(_ payload: RemotePairingPayload) async throws -> (RemoteClient, PairedDesktop, RemoteHelloOutput) {
        guard let desktopKey = Base64URL.decode(payload.desktopKey), let token = Base64URL.decode(payload.token) else {
            throw PairingURLError.malformedPayload
        }
        let identity = try await identityProvider.identity()
        var lastError: Error?
        for endpoint in payload.endpoints {
            try Task.checkCancellation()
            guard let url = URL(string: endpoint.url) else { continue }
            var pairedClient: RemoteClient?
            do {
                let client = try await withTimeout {
                    try await RemoteClient.pair(endpoint: url, desktopKey: desktopKey, token: token, identity: identity, channelFactory: channelFactory)
                }
                pairedClient = client
                let (hello, grant) = try await pairingGreeting(client: client)
                try Task.checkCancellation()
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
                pairedClient?.close()
                try Task.checkCancellation()
                lastError = error
            }
        }
        throw lastError ?? PairingURLError.malformedPayload
    }

    /// The authenticated pairing phase must be bounded too: a peer may never send its grant.
    func pairingGreeting(client: RemoteClient) async throws -> (RemoteHelloOutput, PairingGrant) {
        try await withTimeout {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                let hello: RemoteHelloOutput = try await client.call("remote.hello", HelloInput.current)
                try Task.checkCancellation()
                let grant = try await client.pairingGrant()
                try Task.checkCancellation()
                return (hello, grant)
            } onCancel: {
                client.close()
            }
        }
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

/// Resumes a continuation exactly once, whether the value or the continuation comes first.
final class ResumeOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?
    private var value: T?
    private var resumed = false

    func install(_ continuation: CheckedContinuation<T, Never>) {
        let ready: T? = lock.withLock {
            if resumed { return value }
            self.continuation = continuation
            return nil
        }
        if let ready { continuation.resume(returning: ready) }
    }

    func resume(_ value: T) {
        let waiting: CheckedContinuation<T, Never>? = lock.withLock {
            guard !resumed else { return nil }
            resumed = true
            self.value = value
            defer { continuation = nil }
            return continuation
        }
        waiting?.resume(returning: value)
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
