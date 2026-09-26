import Foundation

/// Decides, per connection, whether events can be applied incrementally or the phone must
/// refetch (`resync`). Pure state so the resume rules are unit-testable without a socket.
public struct EventCursorTracker: Equatable, Sendable {
    public enum Decision: Equatable, Sendable {
        case apply(RemoteEvent, seq: Int)
        /// Already applied (seen before a reconnect replayed it).
        case skip
        /// The stream can no longer be trusted: refetch threads and the open thread.
        case resync
    }

    public private(set) var cursor: ResumeCursor?

    public init(cursor: ResumeCursor? = nil) {
        self.cursor = cursor
    }

    /// Arguments for `events.subscribe` after (re)connecting.
    public func subscribeInput(threadIds: [String]) -> RemoteEventsSubscribeInput {
        RemoteEventsSubscribeInput(
            resumeFrom: cursor.map { ResumeFrom(epoch: $0.epoch, seq: $0.seq) },
            threadIds: threadIds
        )
    }

    /// Applies the `events.subscribe` result. Returns true when the phone must refetch.
    public mutating func accept(_ output: RemoteEventsSubscribeOutput) -> Bool {
        let needsResync = !output.resumed
        if needsResync || cursor?.epoch != output.epoch {
            cursor = ResumeCursor(epoch: output.epoch, seq: output.headSeq)
        }
        return needsResync
    }

    /// One decision per event: a `batch` push expands to its items in seq order, and stops at
    /// the first resync because the rest of that stream is no longer trusted.
    public mutating func observe(_ push: RemotePush) -> [Decision] {
        switch push.type {
        case .resync:
            cursor = ResumeCursor(epoch: push.epoch, seq: push.seq ?? 0)
            return [.resync]
        case .event:
            guard let event = push.event, let seq = push.seq else { return [.skip] }
            return [observe(event, seq: seq, epoch: push.epoch)]
        case .batch:
            var decisions: [Decision] = []
            for item in push.items ?? [] {
                let decision = observe(item.event, seq: item.seq, epoch: push.epoch)
                decisions.append(decision)
                if decision == .resync { break }
            }
            return decisions
        }
    }

    private mutating func observe(_ event: RemoteEvent, seq: Int, epoch: String) -> Decision {
        if let cursor, cursor.epoch != epoch {
            self.cursor = ResumeCursor(epoch: epoch, seq: seq)
            return .resync
        }
        if let cursor, seq <= cursor.seq { return .skip }
        cursor = ResumeCursor(epoch: epoch, seq: seq)
        return .apply(event, seq: seq)
    }
}
