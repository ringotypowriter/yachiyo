import XCTest
@testable import YachiyoRemoteKit

final class RemoteHistoryWindowTests: XCTestCase {
    func testTwoOlderPagesMergeWhileTheNewestPageKeepsChanging() throws {
        var window = RemoteHistoryWindow(latest: try page(111 ... 160, hasMoreBefore: true))
        XCTAssertEqual(window.olderCursor, "m111")

        // A reply arrives before the first older page does.
        window.upsert(try message(161))
        XCTAssertTrue(window.prependOlder(try page(61 ... 110, hasMoreBefore: true), cursor: "m111"))
        XCTAssertEqual(window.olderCursor, "m61")

        // The run finishes and the newest page is reloaded two messages further on.
        window.replaceLatest(try page(113 ... 162, hasMoreBefore: true))
        XCTAssertEqual(window.olderCursor, "m61")
        XCTAssertTrue(window.prependOlder(try page(11 ... 60, hasMoreBefore: true), cursor: "m61"))

        XCTAssertEqual(window.detail.messages.map(\.id), (11 ... 162).map { "m\($0)" })
        XCTAssertEqual(window.olderCount, 102)
        XCTAssertEqual(window.olderCursor, "m11")
    }

    func testReachingTheFirstMessageEndsPaging() throws {
        var window = RemoteHistoryWindow(latest: try page(51 ... 100, hasMoreBefore: true))
        XCTAssertTrue(window.prependOlder(try page(1 ... 50, hasMoreBefore: false), cursor: "m51"))
        XCTAssertNil(window.olderCursor)
        XCTAssertEqual(window.detail.messages.count, 100)
    }

    func testOlderPageNeverOverridesNewerRunState() throws {
        let latest = try page(51 ... 100, hasMoreBefore: true, activeRunId: "run-new", tools: [
            try tool("live", assistant: nil, run: "run-new", title: "current"),
            try tool("t-60", assistant: "m60", run: "run-old", title: "current"),
        ])
        var window = RemoteHistoryWindow(latest: latest)
        let older = try page(1 ... 50, hasMoreBefore: false, activeRunId: "run-stale", followUps: [try message(900)], tools: [
            try tool("live", assistant: nil, run: "run-new", title: "stale"),
            try tool("t-60", assistant: "m60", run: "run-old", title: "stale"),
            try tool("t-20", assistant: "m20", run: "run-older", title: "older"),
            try tool("detached", assistant: nil, run: "run-stale", title: "stale"),
        ])
        XCTAssertTrue(window.prependOlder(older, cursor: "m51"))

        XCTAssertEqual(window.detail.activeRunId, "run-new")
        XCTAssertTrue(window.detail.queuedFollowUps.isEmpty)
        XCTAssertEqual(window.detail.toolCalls.map(\.id), ["t-20", "live", "t-60"])
        XCTAssertEqual(window.detail.toolCalls.map(\.title), ["older", "current", "current"])
    }

    func testResponseForAnotherWindowIsRejected() throws {
        var window = RemoteHistoryWindow(latest: try page(51 ... 100, hasMoreBefore: true))
        XCTAssertTrue(window.prependOlder(try page(31 ... 50, hasMoreBefore: true), cursor: "m51"))
        // Another branch was selected: its newest page starts outside the loaded window.
        let branch = try page(201 ... 250, hasMoreBefore: true)
        window.replaceLatest(branch)
        XCTAssertEqual(window.detail, branch)
        XCTAssertEqual(window.olderCount, 0)

        let before = window
        XCTAssertFalse(window.prependOlder(try page(1 ... 30, hasMoreBefore: false), cursor: "m31"))
        XCTAssertEqual(window, before)
    }

    func testReloadThatReachesIntoOlderPagesKeepsOnlyTheirAncestors() throws {
        var window = RemoteHistoryWindow(latest: try page(51 ... 100, hasMoreBefore: true))
        XCTAssertTrue(window.prependOlder(try page(1 ... 50, hasMoreBefore: false), cursor: "m51"))
        // An edit removed the tail, so the newest page now starts at m21.
        window.replaceLatest(try page(21 ... 70, hasMoreBefore: true))
        XCTAssertEqual(window.detail.messages.map(\.id), (1 ... 70).map { "m\($0)" })
        XCTAssertEqual(window.olderCount, 20)
        XCTAssertNil(window.olderCursor)
    }

    func testOnlyTheNewestPageIsCached() throws {
        var window = RemoteHistoryWindow(latest: try page(51 ... 100, hasMoreBefore: true, tools: [
            try tool("t-60", assistant: "m60", run: "run", title: "newest"),
        ]))
        XCTAssertEqual(window.latestPage, window.detail)
        XCTAssertTrue(window.prependOlder(try page(1 ... 50, hasMoreBefore: false, tools: [
            try tool("t-20", assistant: "m20", run: "run", title: "older"),
        ]), cursor: "m51"))
        window.upsert(try message(101))

        let cached = window.latestPage
        XCTAssertEqual(cached.messages.map(\.id), (51 ... 101).map { "m\($0)" })
        XCTAssertEqual(cached.toolCalls.map(\.id), ["t-60"])
        XCTAssertTrue(cached.hasMoreBefore)
    }

    func testPageWithoutNewMessagesIsNotRequestedAgain() throws {
        var window = RemoteHistoryWindow(latest: try page(51 ... 100, hasMoreBefore: true))
        XCTAssertTrue(window.prependOlder(try page(51 ... 60, hasMoreBefore: true), cursor: "m51"))
        XCTAssertEqual(window.detail.messages.count, 50)
        XCTAssertNil(window.olderCursor)
    }

    // MARK: Fixtures

    private func message(_ index: Int) throws -> RemoteMessage {
        let json = #"""
        {"id":"m\#(index)","content":"Message \#(index)","createdAt":"2026-09-22",
         "role":"\#(index.isMultiple(of: 2) ? "assistant" : "user")","status":"completed",
         "attachments":[],"images":[],"isPlanDocument":false}
        """#
        return try JSONDecoder().decode(RemoteMessage.self, from: Data(json.utf8))
    }

    private func tool(_ id: String, assistant: String?, run: String, title: String) throws -> RemoteToolCall {
        let link = assistant.map { #""assistantMessageId":"\#($0)","# } ?? ""
        let json = #"""
        {"id":"\#(id)",\#(link)"runId":"\#(run)","startedAt":"2026-09-22","status":"completed",
         "title":"\#(title)","toolName":"read","truncated":false}
        """#
        return try JSONDecoder().decode(RemoteToolCall.self, from: Data(json.utf8))
    }

    private func page(
        _ range: ClosedRange<Int>, hasMoreBefore: Bool, activeRunId: String? = nil,
        followUps: [RemoteMessage] = [], tools: [RemoteToolCall] = []
    ) throws -> RemoteThreadDetail {
        let json = #"""
        {"id":"t1","title":"Thread","updatedAt":"2026-09-22","needsAttention":false,"starred":false,
         "capabilities":{"canCreateBranch":true,"canEdit":true,"canRetry":true,"canSelectReplyBranch":true,"canSend":true}}
        """#
        return RemoteThreadDetail(
            activeRunId: activeRunId, activeRunMode: nil, hasMoreBefore: hasMoreBefore,
            messages: try range.map(message), pendingPlan: false, queuedFollowUps: followUps,
            streamSnapshotSeq: nil,
            thread: try JSONDecoder().decode(RemoteThreadSummary.self, from: Data(json.utf8)),
            todoItems: [], toolCalls: tools
        )
    }
}
