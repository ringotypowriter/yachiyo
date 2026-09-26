import Combine
import Foundation
import YachiyoRemoteKit

enum DesktopConnectionState: Equatable {
    case connecting
    case online
    /// Disconnected or suspended; cached content remains available.
    case offline(lastSeen: Date?)
    case protocolMismatch
}

/// Keeps one paired desktop connected while the app is in the foreground: dials (with mailbox
/// recovery), says hello, resumes the event stream, and reconnects with backoff.
///
/// Pushes are consumed from the moment a client exists, before the greeting completes: the
/// desktop may replay a backlog ahead of the `events.subscribe` reply, and the client's push
/// buffer applies backpressure instead of dropping, so an idle consumer would stall that reply.
@MainActor
final class DesktopLink {
    /// Deadline for the greeting and heartbeat calls. Like every call timeout it is an idle
    /// timeout: any frame received from the desktop restarts it.
    private static let greetingTimeout: Duration = .seconds(10)
    private static let heartbeatInterval: Duration = .seconds(20)
    /// A connection this old (or one that applied events) resets the reconnect backoff.
    private static let healthyAfter: Duration = .seconds(30)

    private(set) var desktop: PairedDesktop
    private(set) var state: DesktopConnectionState = .connecting
    private(set) var hello: RemoteHelloOutput?
    private(set) var client: RemoteClient?
    private var tracker: EventCursorTracker
    var cursor: ResumeCursor? { tracker.cursor }
    private var watchTask: Task<Void, Never>?
    private var watchToken = UUID()
    private var watchedThreadIds: [String] = []
    private var threadIds: [String] = []
    private var runTask: Task<Void, Never>?
    private var generation = UUID()
    private let connector: DesktopConnector
    private let onChange: @MainActor (DesktopLink) -> Void
    private let onEvent: @MainActor (DesktopLink, RemoteEvent, Int) -> Void
    private let onResync: @MainActor (DesktopLink) -> Void
    private let persist: @MainActor (PairedDesktop) -> Void
    /// The record last handed to `persist`, to skip writes that would change nothing.
    private var lastPersisted: PairedDesktop
    /// A hello already obtained for the initial client (pairing), so it is not asked again.
    private var initialHello: (client: RemoteClient, hello: RemoteHelloOutput)?
    private var appliedEvents = 0
    private var lastSeen: Date?
    private var connectionPhase = "Connection"
    private var callTimedOut = false
    private(set) var attemptingURL: String?
    private(set) var activeURL: String?
    private(set) var lastConnectionError: String?
    private(set) var recovery: AddressRecoveryStatus?
    private var recoveryTask: Task<Void, Never>?
    private var recoveryReadTask: Task<(PairedDesktop, AddressRecoveryStatus), Never>?


    init(
        desktop: PairedDesktop,
        connector: DesktopConnector,
        client: RemoteClient? = nil,
        hello: RemoteHelloOutput? = nil,
        cachedCursor: ResumeCursor? = nil,
        onChange: @escaping @MainActor (DesktopLink) -> Void,
        onEvent: @escaping @MainActor (DesktopLink, RemoteEvent, Int) -> Void,
        onResync: @escaping @MainActor (DesktopLink) -> Void,
        persist: @escaping @MainActor (PairedDesktop) -> Void
    ) {
        // The Keychain record no longer carries the cursor (the snapshot cache does). A legacy
        // record's cursor is ignored: it was saved more often than the cache and can be ahead
        // of the cached data, which would skip events. The first persist drops it.
        var record = desktop
        record.cursor = nil
        self.desktop = record
        lastPersisted = desktop
        self.connector = connector
        self.client = client
        self.hello = hello
        if let client, let hello { initialHello = (client, hello) }
        if client != nil { attemptingURL = desktop.lastSuccessfulURL }
        tracker = EventCursorTracker(cursor: cachedCursor)
        self.onChange = onChange
        self.onEvent = onEvent
        self.onResync = onResync
        self.persist = persist
    }

    var id: String { desktop.remoteDeviceId }
    var displayName: String { hello?.deviceName ?? desktop.deviceName }

    func start() {
        guard runTask == nil else { return }
        generation = UUID()
        let generation = generation
        runTask = Task { [weak self] in await self?.run(generation: generation) }
        setState(.connecting)
    }

    /// Invalidates suspended work before closing the socket; cached identity and cursor survive.
    func stop() {
        generation = UUID()
        recoveryReadTask?.cancel()
        recoveryReadTask = nil
        recoveryTask?.cancel()
        recoveryTask = nil
        if recovery?.outcome == .checking { recovery = nil }
        runTask?.cancel()
        runTask = nil
        disconnect()
        setState(.offline(lastSeen: lastSeen))
    }

    func replaceDesktop(_ updated: PairedDesktop) {
        // Install the already-persisted record before stop checkpoints it.
        desktop = updated
        desktop.cursor = nil
        lastPersisted = updated
        stop()
        persistIfChanged()
        onChange(self)
        start()
    }

    /// Persists identity and endpoint changes (including a new `lastSuccessfulURL`, which the
    /// next launch dials first). The cursor is checkpointed by the snapshot cache instead.
    private func persistIfChanged() {
        guard desktop != lastPersisted else { return }
        lastPersisted = desktop
        persist(desktop)
    }

    func checkAddressRecovery() async {
        if let recoveryTask { await recoveryTask.value; return }
        let token = generation
        let original = desktop
        recovery = AddressRecoveryStatus(outcome: .checking)
        onChange(self)
        let task = Task { [weak self] in
            guard let self else { return }
            let (updated, status) = await readRecovery(original, generation: token)
            guard isCurrent(token) else { return }
            recoveryTask = nil
            recovery = status
            let changed = updated.endpoints != desktop.endpoints
            let lastSuccessfulURL = desktop.lastSuccessfulURL
            desktop = updated
            desktop.lastSuccessfulURL = lastSuccessfulURL
            desktop.cursor = nil
            persistIfChanged()
            onChange(self)
            if changed { stop(); start() }
        }
        recoveryTask = task
        await task.value
    }

    private func readRecovery(_ original: PairedDesktop, generation token: UUID) async -> (PairedDesktop, AddressRecoveryStatus) {
        guard isCurrent(token) else { return (original, AddressRecoveryStatus(outcome: .failed)) }
        if let recoveryReadTask { return await recoveryReadTask.value }
        let task = Task { await connector.recover(original) }
        recoveryReadTask = task
        let result = await task.value
        if isCurrent(token) { recoveryReadTask = nil }
        return result
    }

    func call<Output: Decodable>(_ method: String, _ input: some Encodable) async throws -> Output {
        guard let client, state == .online else { throw RemoteCallError(name: "RemoteOffline", message: "\(displayName) is offline.") }
        let generation = generation
        let output: Output = try await client.call(method, input)
        try checkCurrent(generation, client: client)
        return output
    }

    /// Queues a call immediately and returns its handle. Calls started one after another reach
    /// the desktop in that order, which lets a caller keep several in flight (chunk uploads).
    func startCall<Output: Decodable>(_ method: String, _ input: some Encodable, as _: Output.Type = Output.self) throws -> RemotePendingCall<Output> {
        guard let client, state == .online else { throw RemoteCallError(name: "RemoteOffline", message: "\(displayName) is offline.") }
        return try client.start(method, input, as: Output.self)
    }

    /// Scope-only replies must not advance the replay cursor past queued pushes.
    func watch(threadIds: [String]) {
        guard self.threadIds != threadIds || (watchedThreadIds != threadIds && watchTask == nil) else { return }
        self.threadIds = threadIds
        guard let client, state == .online else { return }
        let generation = generation
        let previous = watchTask
        let token = UUID()
        watchToken = token
        watchTask = Task {
            defer { if watchToken == token { watchTask = nil } }
            await previous?.value
            do {
                try checkCurrent(generation, client: client)
                let output: RemoteEventsSubscribeOutput = try await client.call("events.subscribe",
                    RemoteEventsSubscribeInput(resumeFrom: nil, threadIds: threadIds), timeout: Self.greetingTimeout)
                try checkCurrent(generation, client: client)
                watchedThreadIds = threadIds
                if output.epoch != tracker.cursor?.epoch { onResync(self) }
            } catch {
                // Closing wakes the push consumer, which owns reconnect and state changes.
                guard isCurrent(generation), self.client === client else { return }
                client.close()
            }
        }
    }

    func waitForWatch(threadId: String) async -> Bool {
        await watchTask?.value
        return state == .online && threadIds.contains(threadId) && watchedThreadIds.contains(threadId)
    }

    private func isCurrent(_ generation: UUID) -> Bool {
        self.generation == generation && !Task.isCancelled
    }

    private func checkCurrent(_ generation: UUID, client: RemoteClient? = nil) throws {
        guard isCurrent(generation), client == nil || self.client === client else { throw CancellationError() }
    }

    private func disconnect() {
        watchToken = UUID()
        watchTask?.cancel()
        watchTask = nil
        watchedThreadIds = []
        client?.close()
        client = nil
        activeURL = nil
        attemptingURL = nil
        persistIfChanged()
    }

    private func run(generation: UUID) async {
        defer { if self.generation == generation { runTask = nil } }
        var attempt = 0
        while isCurrent(generation) {
            var healthy = false
            do {
                connectionPhase = "Connection"
                callTimedOut = false
                setState(.connecting)
                let connected = try await dial(generation: generation)
                appliedEvents = 0
                let consumer = Task { await self.consumePushes(connected, generation: generation) }
                do {
                    try await greet(connected, generation: generation)
                } catch {
                    connected.close()
                    await consumer.value
                    healthy = appliedEvents > 0
                    throw error
                }
                let onlineSince = ContinuousClock.now
                let heartbeat = Task { await self.heartbeat(connected, generation: generation) }
                await consumer.value
                heartbeat.cancel()
                healthy = appliedEvents > 0 || onlineSince.duration(to: .now) >= Self.healthyAfter
            } catch {
                guard isCurrent(generation) else { return }
                let underlying = (error as? DesktopUnreachable)?.lastError ?? error
                if callTimedOut {
                    lastConnectionError = "\(connectionPhase) timed out. The desktop did not respond."
                } else if let urlError = underlying as? URLError {
                    switch urlError.code {
                    case .timedOut: lastConnectionError = "Connection timed out. Check the address and desktop service."
                    case .cannotFindHost, .dnsLookupFailed: lastConnectionError = "The address host could not be resolved."
                    case .notConnectedToInternet, .networkConnectionLost: lastConnectionError = "The network is unavailable or the connection was lost."
                    case .cannotConnectToHost: lastConnectionError = "The host could not be reached. Check the port and desktop service."
                    default: lastConnectionError = "The network or secure WebSocket connection failed."
                    }
                } else if underlying is NoiseError {
                    lastConnectionError = "The secure handshake failed. The server may not match the paired desktop identity."
                } else {
                    lastConnectionError = "\(connectionPhase) failed or closed. Check the desktop service and paired device identity."
                }
                if let error = error as? RemoteCallError, error.name == "RemoteProtocolVersionMismatch" {
                    disconnect()
                    setState(.protocolMismatch)
                    return
                }
                if let error = error as? DesktopUnreachable {
                    desktop = error.updated
                    desktop.cursor = nil
                    persistIfChanged()
                }
            }
            guard isCurrent(generation) else { return }
            if lastConnectionError == nil { lastConnectionError = "The connection closed. Reconnecting to the paired desktop." }
            disconnect()
            setState(.offline(lastSeen: lastSeen))
            // A connection that failed soon after it was established (timeouts, a closing
            // desktop) keeps backing off instead of re-handshaking every second.
            attempt = healthy ? 1 : attempt + 1
            let delays: [Double] = [1, 2, 5, 10, 30]
            let delay = delays[min(attempt - 1, delays.count - 1)] * Double.random(in: 0.8 ... 1.2)
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
        }
    }

    private func dial(generation: UUID) async throws -> RemoteClient {
        if let client { return client }
        let (connected, updated) = try await connector.connect(desktop, recoverUsing: { [weak self] original in
            guard let self else { return (original, AddressRecoveryStatus(outcome: .failed)) }
            return await self.readRecovery(original, generation: generation)
        }, observe: { [weak self] progress in
            await self?.accept(progress, generation: generation)
        })
        guard isCurrent(generation) else {
            connected.close()
            throw CancellationError()
        }
        client = connected
        if updated.mailboxCounter >= desktop.mailboxCounter, updated != desktop {
            desktop = updated
            desktop.cursor = nil
            persistIfChanged()
        }
        return connected
    }

    /// Hello and subscribe; the push consumer is already running.
    private func greet(_ client: RemoteClient, generation: UUID) async throws {
        connectionPhase = "Desktop greeting"
        let subscribedThreads = threadIds
        let known = initialHello.flatMap { $0.client === client ? $0.hello : nil }
        initialHello = nil
        let greeting: (hello: RemoteHelloOutput, subscription: RemoteEventsSubscribeOutput)
        do {
            greeting = try await client.greet(subscribe: tracker.subscribeInput(threadIds: subscribedThreads),
                                              knownHello: known, timeout: Self.greetingTimeout)
        } catch let error as URLError where error.code == .timedOut {
            callTimedOut = true
            throw error
        }
        try checkCurrent(generation, client: client)
        hello = greeting.hello
        let output = greeting.subscription
        // Replayed pushes applied before this reply advanced the cursor already; a resumed
        // stream keeps it.
        let needsResync = tracker.accept(output)
        lastSeen = Date()
        watchedThreadIds = subscribedThreads
        if needsResync || greeting.hello.epoch != output.epoch { onResync(self) }
        activeURL = attemptingURL
        attemptingURL = nil
        desktop.lastSuccessfulURL = activeURL ?? desktop.lastSuccessfulURL
        lastConnectionError = nil
        persistIfChanged()
        setState(.online)
        if subscribedThreads != threadIds { watch(threadIds: threadIds) }
    }

    /// Keeps a quiet connection honest. Skipped while frames keep arriving: any frame proves
    /// the socket is alive, and each hello costs the desktop a runtime RPC.
    private func heartbeat(_ client: RemoteClient, generation: UUID) async {
        while isCurrent(generation), self.client === client {
            let quiet = client.lastReceivedAt.duration(to: .now)
            do {
                if quiet < Self.heartbeatInterval {
                    try await Task.sleep(for: Self.heartbeatInterval - quiet)
                    continue
                }
                try checkCurrent(generation, client: client)
                let _: RemoteHelloOutput = try await client.call("remote.hello", HelloInput.current, timeout: Self.greetingTimeout)
                try checkCurrent(generation, client: client)
                lastSeen = Date()
            } catch {
                guard isCurrent(generation), self.client === client else { return }
                if (error as? URLError)?.code == .timedOut {
                    lastConnectionError = "The desktop did not respond to remote.hello before the timeout."
                }
                client.close()
                return
            }
        }
    }

    private func accept(_ progress: DesktopConnector.Progress, generation: UUID) {
        guard isCurrent(generation) else { return }
        switch progress {
        case let .attempting(url), let .connected(url): attemptingURL = url
        case let .recovery(status, updated):
            attemptingURL = nil
            recovery = status
            if status.outcome != .checking {
                desktop = updated
                desktop.cursor = nil
                persistIfChanged()
            }
        }
        onChange(self)
    }

    private func consumePushes(_ client: RemoteClient, generation: UUID) async {
        for await push in client.pushes {
            guard isCurrent(generation), self.client === client else { return }
            lastSeen = Date()
            for decision in tracker.observe(push) {
                switch decision {
                case let .apply(event, seq):
                    appliedEvents += 1
                    onEvent(self, event, seq)
                case .skip: continue
                case .resync: onResync(self)
                }
            }
        }
    }

    private func setState(_ next: DesktopConnectionState) {
        guard state != next else { return }
        state = next
        onChange(self)
    }
}
