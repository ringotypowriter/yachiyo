import CryptoKit
import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class RemoteCacheTests: XCTestCase {
    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testSentImageSurvivesStoreRecreationAndIsScopedToDesktopThreadMessageAndIndex() throws {
        let directory = temporaryDirectory()
        let original = RemoteSentImageStore(directory: directory)
        let image = Data([0xFF, 0xD8, 0xFF])
        try original.save(image, desktopId: "mac", threadId: "thread", messageId: "message", imageId: "0")
        let reopened = RemoteSentImageStore(directory: directory)
        XCTAssertEqual(reopened.load(desktopId: "mac", threadId: "thread", messageId: "message", imageId: "0"), image)
        XCTAssertNil(reopened.load(desktopId: "other", threadId: "thread", messageId: "message", imageId: "0"))
        XCTAssertNil(reopened.load(desktopId: "mac", threadId: "other", messageId: "message", imageId: "0"))
        XCTAssertNil(reopened.load(desktopId: "mac", threadId: "thread", messageId: "other", imageId: "0"))
        XCTAssertNil(reopened.load(desktopId: "mac", threadId: "thread", messageId: "message", imageId: "1"))
        try reopened.remove(desktopId: "mac")
        XCTAssertNil(reopened.load(desktopId: "mac", threadId: "thread", messageId: "message", imageId: "0"))
    }

    func testRemovingThreadOnlyDeletesItsImagesAndIsIdempotent() throws {
        let store = RemoteSentImageStore(directory: temporaryDirectory())
        try store.save(Data([1]), desktopId: "mac", threadId: "deleted", messageId: "same", imageId: "0")
        try store.save(Data([2]), desktopId: "mac", threadId: "kept", messageId: "same", imageId: "0")
        try store.save(Data([3]), desktopId: "other", threadId: "deleted", messageId: "same", imageId: "0")
        try store.remove(desktopId: "mac", threadId: "deleted")
        try store.remove(desktopId: "mac", threadId: "deleted")
        XCTAssertNil(store.load(desktopId: "mac", threadId: "deleted", messageId: "same", imageId: "0"))
        XCTAssertEqual(store.load(desktopId: "mac", threadId: "kept", messageId: "same", imageId: "0"), Data([2]))
        XCTAssertEqual(store.load(desktopId: "other", threadId: "deleted", messageId: "same", imageId: "0"), Data([3]))
    }

    func testPendingSteerImageSurvivesRecreationAndPromotion() throws {
        let directory = temporaryDirectory()
        let store = RemoteSentImageStore(directory: directory)
        let filename = UUID().uuidString + ".jpeg"
        let bytes = Data([1, 2, 3])
        try store.savePending(bytes, desktopId: "mac", threadId: "thread", filename: filename, runId: "run")
        let reopened = RemoteSentImageStore(directory: directory)
        XCTAssertEqual(reopened.loadPending(desktopId: "mac", threadId: "thread", filename: filename)?.runId, "run")
        XCTAssertEqual(reopened.loadPending(desktopId: "mac", threadId: "thread", filename: filename)?.data, bytes)
        XCTAssertNil(reopened.loadPending(desktopId: "mac", threadId: "other", filename: filename))
        try reopened.save(bytes, desktopId: "mac", threadId: "thread", messageId: "steer", imageId: "0")
        try reopened.removePending(desktopId: "mac", threadId: "thread", filename: filename)
        XCTAssertNil(reopened.loadPending(desktopId: "mac", threadId: "thread", filename: filename))
        XCTAssertEqual(reopened.load(desktopId: "mac", threadId: "thread", messageId: "steer", imageId: "0"), bytes)
    }

    func testSentImageIdentifiersCannotEscapeStorageDirectory() throws {
        let directory = temporaryDirectory()
        let store = RemoteSentImageStore(directory: directory)
        try store.save(Data([1]), desktopId: "../outside", threadId: "../../thread", messageId: "../../message", imageId: "../../0")
        XCTAssertEqual(store.load(desktopId: "../outside", threadId: "../../thread", messageId: "../../message", imageId: "../../0"), Data([1]))
        let folders = try snapshotFiles(in: directory)
        XCTAssertEqual(folders.count, 1)
        XCTAssertTrue(folders[0].lastPathComponent.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)
        let threads = try snapshotFiles(in: folders[0])
        XCTAssertEqual(threads.count, 1)
        XCTAssertTrue(threads[0].lastPathComponent.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)
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

    private func summary(_ id: String, title: String = "Thread") throws -> RemoteThreadSummary {
        let json = #"""
        {"id":"\#(id)","title":"\#(title)","updatedAt":"2026-09-22","needsAttention":false,"starred":false,
         "capabilities":{"canCreateBranch":true,"canEdit":true,"canRetry":true,"canSelectReplyBranch":true,"canSend":true}}
        """#
        return try JSONDecoder().decode(RemoteThreadSummary.self, from: Data(json.utf8))
    }

    private func desktopFolder(in directory: URL) throws -> URL {
        let folders = try snapshotFiles(in: directory).filter(\.hasDirectoryPath)
        XCTAssertEqual(folders.count, 1)
        return try XCTUnwrap(folders.first)
    }

    func testRoundTripRestoresCursorSummariesIndexAndLazyThreadHistory() throws {
        let directory = temporaryDirectory()
        let detail = try detail()
        let cache = RemoteDesktopCache(
            pairingId: "pair", cursor: ResumeCursor(epoch: "epoch", seq: 42),
            summaries: [detail.thread], needsInboxRefresh: false, threadIds: ["t1", "t2"],
            staleThreadIds: ["t2"]
        )
        try RemoteCacheStore(directory: directory).save(
            cache, desktopId: "desktop", summariesChanged: true,
            threads: ["t1": RemoteCachedThread(detail: detail, needsRefresh: false)]
        )
        let reopened = RemoteCacheStore(directory: directory)
        let loaded = try XCTUnwrap(reopened.load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertEqual(loaded, cache)
        let thread = try XCTUnwrap(reopened.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t1"))
        XCTAssertEqual(thread.detail, detail)
        XCTAssertFalse(thread.needsRefresh)
        XCTAssertNil(reopened.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "other"))
        XCTAssertNil(reopened.loadThread(desktopId: "desktop", pairingId: "other", threadId: "t1"))
    }

    func testInitialAcceptedMessageRemainsCachedUntilFirstDetailLoad() throws {
        let directory = temporaryDirectory()
        let snapshot = try detail()
        let initial = RemoteThreadDetail(activeRunId: "run", activeRunMode: nil, hasMoreBefore: false,
                                          messages: snapshot.messages, pendingPlan: false, queuedFollowUps: [],
                                          streamSnapshotSeq: nil,
                                         thread: snapshot.thread, todoItems: [], toolCalls: [])
        let store = RemoteCacheStore(directory: directory)
        try store.save(RemoteDesktopCache(pairingId: "pair", threadIds: ["t1"]), desktopId: "desktop", summariesChanged: false,
                       threads: ["t1": RemoteCachedThread(detail: initial, needsRefresh: true)])
        let loaded = try XCTUnwrap(store.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t1"))
        XCTAssertEqual(loaded.detail.messages, snapshot.messages)
        XCTAssertEqual(loaded.detail.activeRunId, "run")
        XCTAssertTrue(loaded.needsRefresh)
    }

    func testNeverLoadedAndLoadedEmptyInboxRemainDistinct() throws {
        let store = RemoteCacheStore(directory: temporaryDirectory())
        var cache = RemoteDesktopCache(pairingId: "pair")
        try store.save(cache, desktopId: "desktop", summariesChanged: true)
        let initial = try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertNil(initial.summaries)
        XCTAssertNil(initial.cursor)
        XCTAssertTrue(initial.needsInboxRefresh)
        XCTAssertTrue(initial.threadIds.isEmpty)
        cache.summaries = []
        cache.cursor = ResumeCursor(epoch: "e", seq: 1)
        try store.save(cache, desktopId: "desktop", summariesChanged: true)
        let updated = try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertEqual(updated.summaries, [])
        XCTAssertEqual(updated.cursor, cache.cursor)
    }

    func testUnchangedPartsAreNotRewritten() throws {
        let store = RemoteCacheStore(directory: temporaryDirectory())
        let detail = try detail()
        let first = try summary("a", title: "First")
        var cache = RemoteDesktopCache(pairingId: "pair", cursor: ResumeCursor(epoch: "e", seq: 1), summaries: [first], threadIds: ["t1"])
        try store.save(cache, desktopId: "desktop", summariesChanged: true,
                       threads: ["t1": RemoteCachedThread(detail: detail, needsRefresh: false)])
        // A cursor-only save carries a different in-memory inbox but reports no summary change.
        cache.cursor = ResumeCursor(epoch: "e", seq: 2)
        cache.summaries = [try summary("b", title: "Unsaved")]
        try store.save(cache, desktopId: "desktop", summariesChanged: false)
        let loaded = try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair"))
        XCTAssertEqual(loaded.cursor?.seq, 2)
        XCTAssertEqual(loaded.summaries, [first])
        XCTAssertEqual(store.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t1")?.detail, detail)
    }

    func testRemovedThreadHistoriesAreDeleted() throws {
        let store = RemoteCacheStore(directory: temporaryDirectory())
        let detail = try detail()
        try store.save(RemoteDesktopCache(pairingId: "pair", threadIds: ["t1", "t2"]), desktopId: "desktop", summariesChanged: false,
                       threads: ["t1": RemoteCachedThread(detail: detail), "t2": RemoteCachedThread(detail: detail)])
        try store.save(RemoteDesktopCache(pairingId: "pair", threadIds: ["t2"]), desktopId: "desktop", summariesChanged: false,
                       removedThreadIds: ["t1", "never-cached"])
        XCTAssertNil(store.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t1"))
        XCTAssertNotNil(store.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t2"))
        XCTAssertEqual(store.load(desktopId: "desktop", pairingId: "pair")?.threadIds, ["t2"])
    }

    /// The cursor may lag the saved data but must never lead it: when a changed history can be
    /// neither written nor removed, the save must keep the previous cursor on disk.
    func testCursorIsNotAdvancedPastDataThatFailedToSave() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        let original = try detail()
        try store.save(RemoteDesktopCache(pairingId: "pair", cursor: ResumeCursor(epoch: "e", seq: 1), summaries: [], threadIds: ["t1"]),
                       desktopId: "desktop", summariesChanged: true,
                       threads: ["t1": RemoteCachedThread(detail: original, needsRefresh: false)])
        let threads = try desktopFolder(in: directory).appendingPathComponent("threads")
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: threads.path)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: threads.path) }

        let changed = original.replacingMessages([])
        XCTAssertThrowsError(try store.save(
            RemoteDesktopCache(pairingId: "pair", cursor: ResumeCursor(epoch: "e", seq: 9), summaries: [], threadIds: ["t1"]),
            desktopId: "desktop", summariesChanged: false,
            threads: ["t1": RemoteCachedThread(detail: changed, needsRefresh: false)]
        ))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: threads.path)
        XCTAssertEqual(store.load(desktopId: "desktop", pairingId: "pair")?.cursor?.seq, 1)
        XCTAssertEqual(store.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t1")?.detail, original)
    }

    func testLegacySingleFileCacheIsMigratedWithoutLosingTheInbox() throws {
        let directory = temporaryDirectory()
        let detail = try detail()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacyName = SHA256Hex.digest("desktop") + ".json"
        let legacy: [String: Any] = [
            "version": 1,
            "cache": [
                "pairingId": "pair",
                "cursor": ["epoch": "epoch", "seq": 7],
                "summaries": [try JSONSerialization.jsonObject(with: JSONEncoder().encode(detail.thread))],
                "needsInboxRefresh": false,
                "threads": ["t1": ["detail": try JSONSerialization.jsonObject(with: JSONEncoder().encode(detail)), "needsRefresh": false]],
            ],
        ]
        try JSONSerialization.data(withJSONObject: legacy).write(to: directory.appendingPathComponent(legacyName))

        let store = RemoteCacheStore(directory: directory)
        for _ in 0..<2 {
            let loaded = try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair"))
            XCTAssertEqual(loaded.cursor, ResumeCursor(epoch: "epoch", seq: 7))
            XCTAssertEqual(loaded.summaries, [detail.thread])
            XCTAssertFalse(loaded.needsInboxRefresh)
            XCTAssertEqual(loaded.threadIds, ["t1"])
            XCTAssertEqual(store.loadThread(desktopId: "desktop", pairingId: "pair", threadId: "t1")?.detail, detail)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent(legacyName).path))
    }

    func testMissingAndCorruptSnapshotsAreCacheMisses() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "pair"))
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "desktop", summariesChanged: false)
        let state = try desktopFolder(in: directory).appendingPathComponent("state.json")
        try Data("not JSON".utf8).write(to: state)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "pair"))
    }

    func testCorruptSummariesLoadAsNeverLoaded() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        try store.save(RemoteDesktopCache(pairingId: "pair", cursor: ResumeCursor(epoch: "e", seq: 3), summaries: []),
                       desktopId: "desktop", summariesChanged: true)
        try Data("not JSON".utf8).write(to: desktopFolder(in: directory).appendingPathComponent("summaries.json"))
        // Callers resume from the cursor only when the inbox it describes is present.
        XCTAssertNil(try XCTUnwrap(store.load(desktopId: "desktop", pairingId: "pair")).summaries)
    }

    func testDifferentPairingCannotReadExistingSnapshot() throws {
        let store = RemoteCacheStore(directory: temporaryDirectory())
        try store.save(RemoteDesktopCache(pairingId: "old"), desktopId: "desktop", summariesChanged: false)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "new"))
        XCTAssertNotNil(store.load(desktopId: "desktop", pairingId: "old"))
    }

    func testUnknownSchemaVersionIsACacheMiss() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "desktop", summariesChanged: false)
        let file = try desktopFolder(in: directory).appendingPathComponent("state.json")
        var state = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        state["version"] = 999
        try JSONSerialization.data(withJSONObject: state).write(to: file)
        XCTAssertNil(store.load(desktopId: "desktop", pairingId: "pair"))
    }

    func testDesktopAndThreadIdsAreIsolatedAndCannotBecomePaths() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        let detail = try detail()
        try store.save(RemoteDesktopCache(pairingId: "first"), desktopId: "../outside/desktop", summariesChanged: false,
                       threads: ["../../thread": RemoteCachedThread(detail: detail)])
        try store.save(RemoteDesktopCache(pairingId: "second"), desktopId: "/outside/desktop", summariesChanged: false)
        let folders = try snapshotFiles(in: directory)
        XCTAssertEqual(folders.count, 2)
        XCTAssertTrue(folders.allSatisfy { $0.lastPathComponent.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil })
        let threadFiles = try folders.flatMap { folder -> [URL] in
            let threads = folder.appendingPathComponent("threads")
            return FileManager.default.fileExists(atPath: threads.path) ? try snapshotFiles(in: threads) : []
        }
        XCTAssertEqual(threadFiles.count, 1)
        XCTAssertTrue(threadFiles[0].lastPathComponent.range(of: "^[a-f0-9]{64}\\.json$", options: .regularExpression) != nil)
        XCTAssertNotNil(store.load(desktopId: "../outside/desktop", pairingId: "first"))
        XCTAssertNotNil(store.loadThread(desktopId: "../outside/desktop", pairingId: "first", threadId: "../../thread"))
        XCTAssertNotNil(store.load(desktopId: "/outside/desktop", pairingId: "second"))
        XCTAssertNil(store.load(desktopId: "/outside/desktop", pairingId: "first"))
    }

    func testRemoveDeletesEveryFileOfSelectedDesktopAndIsIdempotent() throws {
        let directory = temporaryDirectory()
        let store = RemoteCacheStore(directory: directory)
        let detail = try detail()
        try store.remove(desktopId: "absent")
        try store.save(RemoteDesktopCache(pairingId: "pair", summaries: [], threadIds: ["t1"]), desktopId: "first", summariesChanged: true,
                       threads: ["t1": RemoteCachedThread(detail: detail)])
        try store.save(RemoteDesktopCache(pairingId: "pair"), desktopId: "second", summariesChanged: false)
        try Data("legacy".utf8).write(to: directory.appendingPathComponent(SHA256Hex.digest("first") + ".json"))
        try store.remove(desktopId: "first")
        try store.remove(desktopId: "first")
        XCTAssertNil(store.load(desktopId: "first", pairingId: "pair"))
        XCTAssertNil(store.loadThread(desktopId: "first", pairingId: "pair", threadId: "t1"))
        XCTAssertNotNil(store.load(desktopId: "second", pairingId: "pair"))
        XCTAssertEqual(try snapshotFiles(in: directory).count, 1)
    }
}

private enum SHA256Hex {
    static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

private extension RemoteThreadDetail {
    func replacingMessages(_ messages: [RemoteMessage]) -> RemoteThreadDetail {
        RemoteThreadDetail(
            activeRunId: activeRunId, activeRunMode: activeRunMode, hasMoreBefore: hasMoreBefore,
            messages: messages, pendingPlan: pendingPlan, queuedFollowUps: queuedFollowUps,
            streamSnapshotSeq: streamSnapshotSeq, thread: thread, todoItems: todoItems, toolCalls: toolCalls
        )
    }
}
