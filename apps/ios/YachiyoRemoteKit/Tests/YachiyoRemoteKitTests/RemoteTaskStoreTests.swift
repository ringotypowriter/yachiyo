import XCTest
@testable import YachiyoRemoteKit

@MainActor
final class RemoteTaskStoreTests: XCTestCase {
    private func task(_ id: String, state: String = "running") -> RemoteTask {
        RemoteTask(id: id, kind: .background, progress: nil, startedAt: "2026-10-11T00:00:00Z", state: state, title: id, updatedAt: nil)
    }

    func testResumeLoadsAndSortsActiveBeforeFinished() async {
        let tasks = [task("done", state: "completed"), task("live")]
        let store = RemoteTaskStore { tasks }
        store.resume()
        await settle(store)
        XCTAssertEqual(store.tasks.map(\.id), ["live", "done"])
        XCTAssertEqual(store.activeCount, 1)
        XCTAssertTrue(store.isLive)
    }

    func testChangesDuringRequestCoalesceIntoOneFollowUp() async {
        var calls = 0
        var pending: CheckedContinuation<[RemoteTask], Error>?
        let store = RemoteTaskStore {
            calls += 1
            if calls == 1 { return try await withCheckedThrowingContinuation { pending = $0 } }
            return [self.task("finished", state: "completed")]
        }
        store.resume()
        while pending == nil { await Task.yield() }
        for _ in 0..<20 { store.refresh() }
        pending?.resume(returning: [task("running")])
        await settle(store)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(store.tasks.map(\.id), ["finished"])
    }

    func testSuspendingIgnoresLateResultAndResumingRecovers() async {
        var pending: CheckedContinuation<[RemoteTask], Error>?
        var calls = 0
        let store = RemoteTaskStore {
            calls += 1
            if calls == 1 { return try await withCheckedThrowingContinuation { pending = $0 } }
            return [self.task("new")]
        }
        store.resume()
        while pending == nil { await Task.yield() }
        store.suspend()
        store.resume()
        await settle(store)
        pending?.resume(returning: [task("stale")])
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(store.tasks.map(\.id), ["new"])
        XCTAssertTrue(store.isLive)
    }

    func testFailureKeepsLastSnapshotButMarksItStaleAndRetryClearsError() async {
        var fail = false
        let store = RemoteTaskStore {
            if fail { throw URLError(.notConnectedToInternet) }
            return [self.task("saved")]
        }
        store.resume()
        await settle(store)
        fail = true
        store.refresh()
        await settle(store)
        XCTAssertEqual(store.tasks.map(\.id), ["saved"])
        XCTAssertFalse(store.isLive)
        XCTAssertNotNil(store.error)
        fail = false
        store.refresh()
        await settle(store)
        XCTAssertNil(store.error)
        XCTAssertTrue(store.isLive)
        store.suspend()
        XCTAssertFalse(store.isLive)
        XCTAssertEqual(store.tasks.count, 1)
    }

    func testStreamingInvalidationsAreThrottledAndCancelledOnSuspend() async throws {
        var calls = 0
        let store = RemoteTaskStore { calls += 1; return [] }
        store.resume()
        await settle(store)
        for _ in 0..<20 { store.invalidate() }
        XCTAssertEqual(calls, 1)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(calls, 2)
        store.invalidate()
        store.suspend()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(calls, 2)
    }

    func testWorkerAndBackgroundTerminalStatesAreNotActive() {
        XCTAssertFalse(task("failed", state: "failed").isActive)
        XCTAssertFalse(task("idle", state: "idle").isActive)
        XCTAssertFalse(task("removed", state: "cancelled").isActive)
        XCTAssertTrue(task("starting", state: "starting").isActive)
    }

    private func settle(_ store: RemoteTaskStore) async {
        for _ in 0..<1000 {
            if !store.isLoading { return }
            await Task.yield()
        }
        XCTFail("Task request did not settle")
    }
}
