import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class MailboxTests: XCTestCase {
    func testOpensTheDesktopMailboxAndRejectsRollback() throws {
        let fixture = try Fixtures.json("mailbox.json") as! [String: Any]
        let keys = try Mailbox.deriveKeys(secret: Data(hex: fixture["mailboxSecret"] as! String))
        XCTAssertEqual(keys.mailboxId, fixture["mailboxId"] as? String)
        XCTAssertEqual(keys.mailboxKey.hex, fixture["mailboxKey"] as? String)

        let box = Data(hex: fixture["box"] as! String)
        let plaintext = try Mailbox.open(box: box, key: keys.mailboxKey, lastCounter: 0)
        XCTAssertEqual(plaintext.counter, 5)
        XCTAssertEqual(plaintext.endpoints.first?.url, "wss://quiet-fox.trycloudflare.com/remote/v1")

        let limit = fixture["rejectWhenLastCounterAtLeast"] as! Int
        XCTAssertThrowsError(try Mailbox.open(box: box, key: keys.mailboxKey, lastCounter: limit)) { error in
            XCTAssertEqual(error as? MailboxError, .rolledBack)
        }

        var tampered = box
        tampered[tampered.count - 1] ^= 0xFF
        XCTAssertThrowsError(try Mailbox.open(box: tampered, key: keys.mailboxKey, lastCounter: 0))
    }
}
