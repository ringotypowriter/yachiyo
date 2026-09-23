import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class RemoteCacheTests: XCTestCase {
    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func snapshotFiles(in directory: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    }

    private func detail() throws -> RemoteThreadDetail {
        let json = #"""
        {
          "hasMoreBefore": false, "pendingPlan": false,
          "messages": [{"id":"m1","content":"Cached reply","createdAt":"2026-09-22",
            "role":"assistant","status":"completed","attachments":[],"images":[],"isPlanDocument":false}],
          "queuedFollowUps": [], "todoItems": [], "toolCalls": [],
          "thread": {"id":"t1","title":"Cached thread","updatedAt":"2026-09-22",
            "needsAttention":false,"starred":false,
            "capabilities":{"canCreateBranch":true,"canEdit":true,"canRetry":true,
              "canSelectReplyBranch":true,"canSend":true}}
        }
        """#
        return try JSONDecoder().decode(RemoteThreadDetail.self, from: Data(json.utf8))
    }

    func testRoundTripRestoresCursorSummariesDetailsAndRefreshFlags() throws {
        let directory = temporaryDirectory()
        let detail = try detail()
        let cache = RemoteDesktopCache(
            pairingId: "pair", cursor: ResumeCursor(epoch: "epoch", seq: 42),
            summaries: [detail.thread], needsInboxRefresh: false,
            threads: ["t1": RemoteCachedThread(detail: detail, needsRefresh: false)]
        )
        try RemoteCacheStore(directory: directory).save(cache, desktopId: "desktop")
        let loaded = try XCTUnwrap(RemoteCacheStore(directory: directory).load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertEqual(loaded.pairingId, "pair")
        XCTAssertEqual(loaded.cursor, cache.cursor)
        XCTAssertEqual(loaded.summaries, cache.summaries)
        XCTAssertFalse(loaded.needsInboxRefresh)
        XCTAssertEqual(loaded.threads["t1"]?.detail, detail)
        XCTAssertEqual(loaded.threads["t1"]?.needsRefresh, false)
        XCTAssertEqual(try snapshotFiles(in: directory).count, 1)
    }

    func testNeverLoadedAndLoadedEmptyInboxRemainDistinctWhenReplaced() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        var cache = RemoteDesktopCache(pairingId: "pair")
        try store.save(cache, desktopId: "desktop")
        let initial = try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertNil(initial.summaries)
        XCTAssertNil(initial.cursor)
        XCTAssertTrue(initial.needsInboxRefresh)
        XCTAssertTrue(initial.threads.isEmpty)
        cache.summaries = []
        cache.cursor = ResumeCursor(epoch: "e", seq: 1)
        try store.save(cache, desktopId: "desktop")
        let updated = try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertEqual(updated.summaries, [])
        XCTAssertEqual(updated.cursor, cache.cursor)
        XCTAssertEqual(try snapshotFiles(in: directory).count, 1)
    }

    func testMissingAndCorruptSnapshotsAreCacheMisses() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "pair"))
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "desktop")
        let file = try XCTUnwrap(snapshotFiles(in: directory).first)
        try Data("not JSON".utf8).write(to: file)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "pair"))
    }

    func testDifferentPairingCannotReadExistingSnapshot() throws {
        let store = RemoteCacheStore(directory: temporaryDirectory())
        try store.save(RemoteDesktopCache(pairingId: "old"), desktopId: "desktop")
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "new"))
        XCTAssertNotNil(store.load(desktopId: "desktop", pairingId: "old"))
    }

    func testUnknownSchemaVersionIsACacheMiss() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "desktop")
        let file = try XCTUnwrap(snapshotFiles(in: directory).first)
        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        envelope["version"] = 999
        try JSONSerialization.data(withJSONObject: envelope).write(to: file)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "pair"))
    }

    func testDesktopIdsAreIsolatedAndCannotBecomePaths() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        try store.save(RemoteDesktopCache(pairingId: "first"), desktopId: "../outside/desktop")
        try store.save(RemoteDesktopCache(pairingId: "second"), desktopId: "/outside/desktop")
        let files = try snapshotFiles(in: directory)
        XCTAssertEqual(files.count, 2)
        XCTAssertTrue(files.allSatisfy { $0.lastPathComponent.range(of: "^[a-f0-9]{64}\\.json$", options: .regularExpression) != nil })
        XCTAssertNotNil(store.load(desktopId: "../outside/desktop", pairingId: "first"))
        XCTAssertNotNil(store.load(desktopId: "/outside/desktop", pairingId: "second"))
        XCTAssertNil(store.load(desktopId: "/outside/desktop", pairingId: "first"))
    }

    func testRemoveOnlyDeletesSelectedDesktopAndIsIdempotent() throws {
        let store = RemoteCacheStore(directory: temporaryDirectory())
        try store.remove(desktopId: "absent")
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "first")
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "second")
        try store.remove(desktopId: "first")
        try store.remove(desktopId: "first")
        XCTAssertNil(store.load(desktopId: "first", pairingId: "pair"))
        XCTAssertNotNil(store.load(desktopId: "second", pairingId: "pair"))
    }
}
