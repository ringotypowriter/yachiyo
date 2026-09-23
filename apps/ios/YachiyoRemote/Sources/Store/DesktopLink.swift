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
@MainActor
final class DesktopLink {
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
    private let onEvent: @MainActor (DesktopLink, RemoteEvent) -> Void
    private let onResync: @MainActor (DesktopLink) -> Void
    private let persist: @MainActor (PairedDesktop) -> Void
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
        onEvent: @escaping @MainActor (DesktopLink, RemoteEvent) -> Void,
        onResync: @escaping @MainActor (DesktopLink) -> Void,
        persist: @escaping @MainActor (PairedDesktop) -> Void
    ) {
        self.desktop = desktop
        self.connector = connector
        self.client = client
        self.hello = hello
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
        stop()
        desktop.cursor = tracker.cursor
        persist(desktop)
        onChange(self)
        start()
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
            desktop.cursor = tracker.cursor
            persist(desktop)
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
                let output: RemoteEventsSubscribeOutput = try await boundedCall(client, "events.subscribe",
                    RemoteEventsSubscribeInput(resumeFrom: nil, threadIds: threadIds))
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
        desktop.cursor = tracker.cursor
        persist(desktop)
    }

    private func run(generation: UUID) async {
        defer { if self.generation == generation { runTask = nil } }
        var attempt = 0
        while isCurrent(generation) {
            do {
                connectionPhase = "Connection"
                callTimedOut = false
                setState(.connecting)
                let connected = try await connectOnce(generation: generation)
                attempt = 0
                await consumePushes(connected, generation: generation)
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
                    desktop.cursor = tracker.cursor
                    persist(desktop)
                }
            }
            guard isCurrent(generation) else { return }
            if lastConnectionError == nil { lastConnectionError = "The connection closed. Reconnecting to the paired desktop." }
            disconnect()
            setState(.offline(lastSeen: lastSeen))
            attempt += 1
            let delays: [Double] = [1, 2, 5, 10, 30]
            do { try await Task.sleep(for: .seconds(delays[min(attempt - 1, delays.count - 1)])) }
            catch { return }
        }
    }

    private func connectOnce(generation: UUID) async throws -> RemoteClient {
        if client == nil {
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
                persist(desktop)
            }
        }
        guard let client else { throw CancellationError() }
        connectionPhase = "Desktop greeting"
        let greeting: RemoteHelloOutput = try await boundedCall(client, "remote.hello", HelloInput.current)
        try checkCurrent(generation, client: client)
        hello = greeting
        connectionPhase = "Event subscription"
        let subscribedThreads = threadIds
        let output: RemoteEventsSubscribeOutput = try await boundedCall(client,
            "events.subscribe", tracker.subscribeInput(threadIds: subscribedThreads))
        try checkCurrent(generation, client: client)
        let needsResync = tracker.accept(output)
        lastSeen = Date()
        watchedThreadIds = subscribedThreads
        if needsResync || greeting.epoch != output.epoch { onResync(self) }
        activeURL = attemptingURL
        attemptingURL = nil
        desktop.lastSuccessfulURL = activeURL ?? desktop.lastSuccessfulURL
        lastConnectionError = nil
        persist(desktop)
        setState(.online)
        if subscribedThreads != threadIds { watch(threadIds: threadIds) }
        return client
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
                desktop.cursor = tracker.cursor
                persist(desktop)
            }
        }
        onChange(self)
    }

    /// A silent half-open socket otherwise leaves the UI online indefinitely. The deadline
    /// closes only this socket, releasing its pending RPCs and push consumer even on timeout.
    private func boundedCall<Output: Decodable>(_ client: RemoteClient, _ method: String, _ input: some Encodable) async throws -> Output {
        let token = generation
        let deadline = Task {
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard isCurrent(token), self.client === client else { return }
            callTimedOut = true
            lastConnectionError = "The desktop did not respond to \(method) before the timeout."
            client.close()
        }
        defer { deadline.cancel() }
        return try await client.call(method, input)
    }

    private func consumePushes(_ client: RemoteClient, generation: UUID) async {
        let heartbeat = Task {
            while isCurrent(generation), self.client === client {
                do {
                    try await Task.sleep(for: .seconds(20))
                    try checkCurrent(generation, client: client)
                    let _: RemoteHelloOutput = try await boundedCall(client, "remote.hello", HelloInput.current)
                    try checkCurrent(generation, client: client)
                    lastSeen = Date()
                } catch {
                    client.close()
                    return
                }
            }
        }
        defer { heartbeat.cancel() }
        for await push in client.pushes {
            guard isCurrent(generation), self.client === client else { return }
            lastSeen = Date()
            switch tracker.observe(push) {
            case let .apply(event): onEvent(self, event)
            case .skip: continue
            case .resync: onResync(self)
            }
        }
    }

    private func setState(_ next: DesktopConnectionState) {
        guard state != next else { return }
        state = next
        onChange(self)
    }
}
