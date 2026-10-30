import Combine
import UIKit
import XCTest
@testable import YachiyoChatUI
import YachiyoRemoteKit
@testable import Yachiyo

@MainActor
final class ThreadRunErrorTests: XCTestCase {
    func testLongErrorFooterWrapsAtPhoneWidth() {
        let list = MessageListView()
        list.applyYachiyoTheme()
        let error = "No API key configured. Open Settings and add a provider key first."
        let entry = MessageListView.Entry.hint("failure", error)
        let phoneHeight = list.contentHeight(for: entry, width: 220)
        let wideHeight = list.contentHeight(for: entry, width: 900)
        XCTAssertGreaterThan(phoneHeight, wideHeight)

        let row = HintMessageView()
        row.text = error
        let label = row.contentView.subviews.compactMap { $0 as? UILabel }.first
        XCTAssertEqual(label?.numberOfLines, 0)
    }

    private func makeStore() -> RemoteStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return RemoteStore(credentials: InMemoryCredentialStore(), cacheStore: RemoteCacheStore(directory: directory))
    }

    private func emit(_ fields: [String: Any], to store: RemoteStore, seq: Int = 1) throws {
        var fields = fields
        fields["threadId"] = "thread"
        let event = try JSONDecoder().decode(RemoteEvent.self, from: JSONSerialization.data(withJSONObject: fields))
        store.threadEvents.send(("mac", event, seq))
    }

    private func footers(_ thread: ThreadStore) -> [String] {
        thread.messages.compactMap { $0.metadata[MessageMetadataKey.footer] }
    }

    func testEarlyHardFailureSurvivesTheLateUserMessageAcknowledgement() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteCacheStore(directory: directory)
        let detail = try JSONDecoder().decode(RemoteThreadDetail.self, from: Data(#"""
        {"thread":{"id":"thread","title":"Thread","updatedAt":"2026-10-30T00:00:00.000Z",
         "starred":false,"needsAttention":false,
         "capabilities":{"canCreateBranch":true,"canEdit":true,"canRetry":true,"canSelectReplyBranch":true,"canSend":true}},
         "messages":[],"toolCalls":[],"todoItems":[],"queuedFollowUps":[],"hasMoreBefore":false,"pendingPlan":false}
        """#.utf8))
        try cache.save(RemoteDesktopCache(pairingId: "pair", summaries: [detail.thread], threadIds: ["thread"]),
                       desktopId: "mac", summariesChanged: true, threads: ["thread": RemoteCachedThread(detail: detail)])
        let credentials = InMemoryCredentialStore()
        try credentials.save(PairedDesktop(remoteDeviceId: "mac", pairingId: "pair", deviceName: "Test Mac",
                                           desktopKey: Data(repeating: 1, count: 32), mailboxSecret: Data(repeating: 2, count: 32), endpoints: []))
        let store = RemoteStore(credentials: credentials, cacheStore: cache)
        await withCheckedContinuation { continuation in store.bootstrap { continuation.resume() } }
        await withCheckedContinuation { continuation in store.suspend { continuation.resume() } }
        let thread = ThreadStore(desktopId: "mac", threadId: "thread", store: store)
        await thread.open()
        defer { thread.close() }
        XCTAssertEqual(thread.detail?.thread.id, "thread")

        try emit(["type": "run.status", "runId": "run", "status": "running"], to: store)
        try emit(["type": "run.status", "runId": "run", "status": "failed", "error": "No API key configured"], to: store)
        try emit(["type": "message.completed", "runId": "run", "message": [
            "id": "request", "role": "user", "content": "Hello", "status": "completed",
            "createdAt": "2026-10-30T00:00:00.000Z", "images": [], "attachments": [], "isPlanDocument": false,
        ]], to: store)

        XCTAssertFalse(thread.isRunning)
        XCTAssertTrue(footers(thread).contains { $0.contains("No API key configured") })
        await withCheckedContinuation { continuation in store.suspend { continuation.resume() } }
    }

    func testRetryBeforeAnyOutputShowsErrorAndClearsWhenReplyResumes() async throws {
        let store = makeStore()
        let thread = ThreadStore(desktopId: "mac", threadId: "thread", store: store)
        await thread.open()
        defer { thread.close() }

        try emit(["type": "run.status", "runId": "run", "status": "running"], to: store)
        try emit(["type": "run.retrying", "runId": "run", "attempt": 2, "maxAttempts": 5, "error": "Connection reset by server"], to: store)

        XCTAssertTrue(thread.isRunning)
        XCTAssertEqual(thread.replyState, .retrying)
        XCTAssertEqual(footers(thread).count, 1)
        XCTAssertTrue(footers(thread).contains { $0.contains("Connection reset by server") })
        XCTAssertTrue(footers(thread).contains { $0.contains("2/5") })

        let resumed = expectation(description: "The reply replaces the retry notice")
        let subscription = thread.messagesDidChange.sink { messages, _ in
            if messages.contains(where: { $0.textContent == "Recovered reply" }), self.footers(thread).isEmpty {
                resumed.fulfill()
            }
        }
        try emit(["type": "message.delta", "runId": "run", "messageId": "reply", "delta": "Recovered reply"], to: store)
        await fulfillment(of: [resumed], timeout: 2)
        subscription.cancel()
        XCTAssertEqual(thread.replyState, .responding)
        try emit(["type": "run.status", "runId": "run", "status": "completed"], to: store)
        XCTAssertFalse(thread.isRunning)
        XCTAssertTrue(footers(thread).isEmpty)
        XCTAssertEqual(thread.messages.flatMap(\.parts).compactMap { if case let .text(text) = $0 { return text.text }; return nil }, ["Recovered reply"])

        // A delayed retry must not restart a run that already finished.
        try emit(["type": "run.retrying", "runId": "run", "attempt": 2, "maxAttempts": 5, "error": "Late error"], to: store)
        XCTAssertFalse(thread.isRunning)
        XCTAssertTrue(footers(thread).isEmpty)
    }

    func testFinalFailureReplacesRetryNoticeAndKeepsTheErrorWithoutAReply() async throws {
        let store = makeStore()
        let thread = ThreadStore(desktopId: "mac", threadId: "thread", store: store)
        await thread.open()
        defer { thread.close() }
        try emit(["type": "run.retrying", "runId": "run", "attempt": 2, "maxAttempts": 5, "error": "Temporary failure"], to: store)
        try emit(["type": "run.status", "runId": "run", "status": "failed", "error": "Unauthorized (HTTP 401)"], to: store)

        XCTAssertFalse(thread.isRunning)
        XCTAssertEqual(footers(thread).count, 1)
        XCTAssertTrue(footers(thread).contains { $0.contains("Unauthorized (HTTP 401)") })
        XCTAssertFalse(footers(thread).contains { $0.contains("Temporary failure") })

        try emit(["type": "run.status", "runId": "next-run", "status": "running"], to: store)
        XCTAssertTrue(thread.isRunning)
        XCTAssertTrue(footers(thread).isEmpty)
    }

    func testOpeningAfterFailureRestoresErrorFromThreadSummary() async throws {
        let store = makeStore()
        let json = #"""
        {"id":"thread","title":"Failed run","updatedAt":"2026-10-30T00:00:00.000Z",
         "starred":false,"needsAttention":false,
         "capabilities":{"canCreateBranch":true,"canEdit":true,"canRetry":true,"canSelectReplyBranch":true,"canSend":true},
         "latestRun":{"runId":"run","status":"failed","startedAt":"2026-10-30T00:00:00.000Z","error":"Unauthorized (HTTP 401)"}}
        """#
        let summary = try JSONDecoder().decode(RemoteThreadSummary.self, from: Data(json.utf8))
        store.upsert(desktopId: "mac", summary: summary)
        let thread = ThreadStore(desktopId: "mac", threadId: "thread", store: store)
        await thread.open()
        defer { thread.close() }

        XCTAssertFalse(thread.isRunning)
        XCTAssertEqual(footers(thread).count, 1)
        XCTAssertTrue(footers(thread).contains { $0.contains("Unauthorized (HTTP 401)") })
    }
}
