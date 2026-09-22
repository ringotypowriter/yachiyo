import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class GeneratedProtocolTests: XCTestCase {
    func testDecodesAServerPushProducedByTheDesktop() throws {
        let json = """
        {"type":"event","epoch":"e1","seq":7,"timestamp":"2026-09-22T12:00:00.000Z",
         "event":{"type":"message.delta","threadId":"t1","runId":"r1","messageId":"m1","delta":"Hel"}}
        """
        let push = try JSONDecoder().decode(RemotePush.self, from: Data(json.utf8))
        XCTAssertEqual(push.seq, 7)
        XCTAssertEqual(push.event?.type, .messageDelta)
        XCTAssertEqual(push.event?.delta, "Hel")
    }
}
