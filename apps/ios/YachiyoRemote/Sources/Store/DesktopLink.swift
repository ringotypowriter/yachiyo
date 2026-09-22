import Combine
import Foundation
import YachiyoRemoteKit

enum DesktopConnectionState: Equatable {
    case connecting
    case online
    /// Every endpoint failed; the mailbox had nothing newer either.
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
    private var threadIds: [String] = []
    private var runTask: Task<Void, Never>?
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
        onChange: @escaping @MainActor (DesktopLink) -> Void,
        onEvent: @escaping @MainActor (DesktopLink, RemoteEvent) -> Void,
        onResync: @escaping @MainActor (DesktopLink) -> Void,
        persist: @escaping @MainActor (PairedDesktop) -> Void
    ) {
        self.desktop = desktop
        self.connector = connector
        self.client = client
        self.hello = hello
        tracker = EventCursorTracker(cursor: desktop.cursor)
        self.onChange = onChange
        self.onEvent = onEvent
        self.onResync = onResync
        self.persist = persist
    }

    var id: String { desktop.remoteDeviceId }
    var displayName: String { hello?.deviceName ?? desktop.deviceName }

    func start() {
        guard runTask == nil else { return }
        runTask = Task { [weak self] in await self?.run() }
    }

    /// Closes the socket (app backgrounded); the cursor is kept for resume.
    func stop() {
        runTask?.cancel()
        runTask = nil
        client?.close()
        client = nil
        desktop.cursor = tracker.cursor
        persist(desktop)
    }

    func call<Output: Decodable>(_ method: String, _ input: some Encodable) async throws -> Output {
        guard let client, state == .online else { throw RemoteCallError(name: "RemoteOffline", message: "\(displayName) is offline.") }
        return try await client.call(method, input)
    }

    /// Changes the thread-scope subscription (the open thread) without replaying anything.
    func watch(threadIds: [String]) {
        self.threadIds = threadIds
        guard let client, state == .online else { return }
        Task {
            let output: RemoteEventsSubscribeOutput? = try? await client.call(
                "events.subscribe",
                RemoteEventsSubscribeInput(resumeFrom: nil, threadIds: threadIds)
            )
            if let output { _ = self.tracker.accept(output) }
        }
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                try await connectOnce()
                attempt = 0
                await consumePushes()
            } catch let error as RemoteCallError where error.name == "RemoteProtocolVersionMismatch" {
                setState(.protocolMismatch)
                return
            } catch let error as DesktopUnreachable {
                desktop = error.updated
                persist(desktop)
                setState(.offline(lastSeen: lastSeen))
            } catch {
                setState(.offline(lastSeen: lastSeen))
            }
            guard !Task.isCancelled else { return }
            attempt += 1
            let delays: [Double] = [1, 2, 5, 10, 30]
            try? await Task.sleep(for: .seconds(delays[min(attempt - 1, delays.count - 1)]))
        }
    }

    private func connectOnce() async throws {
        if client == nil {
            setState(.connecting)
            let (connected, updated) = try await connector.connect(desktop)
            client = connected
            if updated != desktop {
                desktop = updated
                persist(desktop)
            }
            hello = try await connected.call("remote.hello", HelloInput.current)
        }
        guard let client else { return }
        let output: RemoteEventsSubscribeOutput = try await client.call(
            "events.subscribe",
            tracker.subscribeInput(threadIds: threadIds)
        )
        let needsResync = tracker.accept(output)
        lastSeen = Date()
        setState(.online)
        if needsResync || hello?.epoch != output.epoch { onResync(self) }
    }

    private func consumePushes() async {
        guard let client else { return }
        for await push in client.pushes {
            lastSeen = Date()
            switch tracker.observe(push) {
            case let .apply(event):
                onEvent(self, event)
            case .skip:
                continue
            case .resync:
                onResync(self)
            }
        }
        // The stream ended: the socket closed (network change, desktop quit, revoked).
        self.client = nil
        desktop.cursor = tracker.cursor
        persist(desktop)
        setState(.offline(lastSeen: lastSeen))
    }

    private func setState(_ next: DesktopConnectionState) {
        guard state != next else { return }
        state = next
        onChange(self)
    }
}
