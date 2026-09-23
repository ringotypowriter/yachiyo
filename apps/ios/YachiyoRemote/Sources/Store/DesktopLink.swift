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
        runTask?.cancel()
        runTask = nil
        disconnect()
        setState(.offline(lastSeen: lastSeen))
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
        desktop.cursor = tracker.cursor
        persist(desktop)
    }

    private func run(generation: UUID) async {
        defer { if self.generation == generation { runTask = nil } }
        var attempt = 0
        while isCurrent(generation) {
            do {
                setState(.connecting)
                let connected = try await connectOnce(generation: generation)
                attempt = 0
                await consumePushes(connected, generation: generation)
            } catch {
                guard isCurrent(generation) else { return }
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
            let (connected, updated) = try await connector.connect(desktop)
            guard isCurrent(generation) else {
                connected.close()
                throw CancellationError()
            }
            client = connected
            if updated != desktop {
                desktop = updated
                persist(desktop)
            }
        }
        guard let client else { throw CancellationError() }
        let greeting: RemoteHelloOutput = try await boundedCall(client, "remote.hello", HelloInput.current)
        try checkCurrent(generation, client: client)
        hello = greeting
        let subscribedThreads = threadIds
        let output: RemoteEventsSubscribeOutput = try await boundedCall(client,
            "events.subscribe", tracker.subscribeInput(threadIds: subscribedThreads))
        try checkCurrent(generation, client: client)
        let needsResync = tracker.accept(output)
        lastSeen = Date()
        watchedThreadIds = subscribedThreads
        if needsResync || greeting.epoch != output.epoch { onResync(self) }
        setState(.online)
        if subscribedThreads != threadIds { watch(threadIds: threadIds) }
        return client
    }

    /// A silent half-open socket otherwise leaves the UI online indefinitely. The deadline
    /// closes only this socket, releasing its pending RPCs and push consumer even on timeout.
    private func boundedCall<Output: Decodable>(_ client: RemoteClient, _ method: String, _ input: some Encodable) async throws -> Output {
        let deadline = Task {
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
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
