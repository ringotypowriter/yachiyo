import Foundation

/// The loaded span of one thread: the newest page from `threads.load`, plus older pages the
/// reader paged in above it. `detail` carries the whole span; only the newest page is cached.
public struct RemoteHistoryWindow: Equatable, Sendable {
    public private(set) var detail: RemoteThreadDetail
    /// Leading messages that are not part of the newest page.
    public private(set) var olderCount: Int

    public init(latest: RemoteThreadDetail) {
        detail = latest
        olderCount = 0
    }

    /// The `beforeMessageId` of the next older page; nil once the branch's first message is loaded.
    public var olderCursor: String? {
        detail.hasMoreBefore ? detail.messages.first?.id : nil
    }

    /// Replaces the newest page. Messages above it stay when the new page starts inside this
    /// window: they are that message's ancestors, which never change. A page that starts
    /// elsewhere (another branch, or a gap) restarts the window.
    public mutating func replaceLatest(_ latest: RemoteThreadDetail) {
        guard let first = latest.messages.first?.id,
              let index = detail.messages.firstIndex(where: { $0.id == first }), index > 0 else {
            self = RemoteHistoryWindow(latest: latest)
            return
        }
        let latestIds = Set(latest.messages.map(\.id))
        let retained = detail.messages[..<index].filter { !latestIds.contains($0.id) }
        let retainedIds = Set(retained.map(\.id))
        let latestToolIds = Set(latest.toolCalls.map(\.id))
        let retainedTools = detail.toolCalls.filter {
            !latestToolIds.contains($0.id) && $0.belongs(to: retainedIds)
        }
        detail = latest.replacing(
            messages: retained + latest.messages,
            toolCalls: retainedTools + latest.toolCalls,
            hasMoreBefore: detail.hasMoreBefore
        )
        olderCount = retained.count
    }

    /// Prepends the page fetched with `cursor`. Returns false, changing nothing, when the window
    /// no longer starts at `cursor`. Only the page's own messages and their tool calls are taken:
    /// the run state, follow-ups and summary of an older response may already be stale.
    public mutating func prependOlder(_ page: RemoteThreadDetail, cursor: String) -> Bool {
        guard detail.messages.first?.id == cursor else { return false }
        let knownIds = Set(detail.messages.map(\.id))
        let messages = page.messages.filter { !knownIds.contains($0.id) }
        let pageIds = Set(messages.map(\.id))
        let knownToolIds = Set(detail.toolCalls.map(\.id))
        let tools = page.toolCalls.filter { !knownToolIds.contains($0.id) && $0.belongs(to: pageIds) }
        detail = detail.replacing(
            messages: messages + detail.messages,
            toolCalls: tools + detail.toolCalls,
            // A page that adds nothing must not be requested again.
            hasMoreBefore: page.hasMoreBefore && !messages.isEmpty
        )
        olderCount += messages.count
        return true
    }

    /// Replaces the message with the same id, or appends it as the newest message.
    public mutating func upsert(_ message: RemoteMessage) {
        var messages = detail.messages
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        } else {
            messages.append(message)
        }
        detail = detail.replacing(messages: messages, toolCalls: detail.toolCalls, hasMoreBefore: detail.hasMoreBefore)
    }

    /// The newest page alone, as it is cached.
    public var latestPage: RemoteThreadDetail {
        guard olderCount > 0 else { return detail }
        let olderIds = Set(detail.messages.prefix(olderCount).map(\.id))
        let latestIds = Set(detail.messages.dropFirst(olderCount).map(\.id))
        return detail.replacing(
            messages: Array(detail.messages.dropFirst(olderCount)),
            toolCalls: detail.toolCalls.filter { !$0.belongs(to: olderIds) || $0.belongs(to: latestIds) },
            hasMoreBefore: true
        )
    }
}

private extension RemoteToolCall {
    func belongs(to messageIds: Set<String>) -> Bool {
        assistantMessageId.map(messageIds.contains) == true || requestMessageId.map(messageIds.contains) == true
    }
}

private extension RemoteThreadDetail {
    func replacing(messages: [RemoteMessage], toolCalls: [RemoteToolCall], hasMoreBefore: Bool) -> RemoteThreadDetail {
        RemoteThreadDetail(
            activeRunId: activeRunId, activeRunMode: activeRunMode, hasMoreBefore: hasMoreBefore,
            messages: messages, pendingPlan: pendingPlan, queuedFollowUps: queuedFollowUps,
            streamSnapshotSeq: streamSnapshotSeq,
            thread: thread, todoItems: todoItems, toolCalls: toolCalls
        )
    }
}
