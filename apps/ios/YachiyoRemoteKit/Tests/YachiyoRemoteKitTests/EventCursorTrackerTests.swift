import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class EventCursorTrackerTests: XCTestCase {
    private func push(epoch: String = "e1", seq: Int, type: String = "event") throws -> RemotePush {
        let json: String
        if type == "resync" {
            json = #"{"type":"resync","epoch":"\#(epoch)","seq":\#(seq),"reason":"overflow"}"#
        } else {
            json = #"{"type":"event","epoch":"\#(epoch)","seq":\#(seq),"timestamp":"2026-09-22T00:00:00.000Z","event":{"type":"thread.invalidated","threadId":"t1"}}"#
        }
        return try JSONDecoder().decode(RemotePush.self, from: Data(json.utf8))
    }

    func testResumesFromTheLastAppliedEventAndSkipsReplays() throws {
        var tracker = EventCursorTracker()
        XCTAssertNil(tracker.subscribeInput(threadIds: []).resumeFrom)
        XCTAssertTrue(tracker.accept(RemoteEventsSubscribeOutput(epoch: "e1", headSeq: 3, resumed: false)))

        guard case .apply = tracker.observe(try push(seq: 4)) else { return XCTFail("expected apply") }
        XCTAssertEqual(tracker.observe(try push(seq: 4)), .skip)
        XCTAssertEqual(tracker.subscribeInput(threadIds: ["t1"]).resumeFrom, ResumeFrom(epoch: "e1", seq: 4))

        XCTAssertFalse(tracker.accept(RemoteEventsSubscribeOutput(epoch: "e1", headSeq: 6, resumed: true)))
        XCTAssertEqual(tracker.cursor, ResumeCursor(epoch: "e1", seq: 4), "a resumed stream keeps its cursor")
    }

    func testAnEpochChangeOrServerResyncForcesARefetch() throws {
        var tracker = EventCursorTracker(cursor: ResumeCursor(epoch: "e1", seq: 10))
        XCTAssertEqual(tracker.observe(try push(epoch: "e2", seq: 1)), .resync)
        XCTAssertEqual(tracker.cursor, ResumeCursor(epoch: "e2", seq: 1))
        XCTAssertEqual(tracker.observe(try push(epoch: "e2", seq: 5, type: "resync")), .resync)
    }
}
