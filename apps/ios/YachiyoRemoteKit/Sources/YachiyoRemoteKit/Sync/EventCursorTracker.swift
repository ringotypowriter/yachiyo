import Foundation

/// Decides, per connection, whether events can be applied incrementally or the phone must
/// refetch (`resync`). Pure state so the resume rules are unit-testable without a socket.
public struct EventCursorTracker: Equatable, Sendable {
    public enum Decision: Equatable, Sendable {
        case apply(RemoteEvent)
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

    public mutating func observe(_ push: RemotePush) -> Decision {
        switch push.type {
        case .resync:
            cursor = ResumeCursor(epoch: push.epoch, seq: push.seq)
            return .resync
        case .event:
            guard let event = push.event else { return .skip }
            if let cursor, cursor.epoch != push.epoch {
                self.cursor = ResumeCursor(epoch: push.epoch, seq: push.seq)
                return .resync
            }
            if let cursor, push.seq <= cursor.seq { return .skip }
            cursor = ResumeCursor(epoch: push.epoch, seq: push.seq)
            return .apply(event)
        }
    }
}
