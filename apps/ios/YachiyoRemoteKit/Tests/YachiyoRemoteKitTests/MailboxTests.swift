import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class MailboxTests: XCTestCase {
    func testRecoveryFolderMustBeYachiyoContainingRemote() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let folder = root.appendingPathComponent("Documents/Yachiyo")
        let remote = folder.appendingPathComponent("Remote")
        try FileManager.default.createDirectory(at: remote, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertNoThrow(try BookmarkedFolderMailboxSource.validateFolder(folder))
        XCTAssertThrowsError(try BookmarkedFolderMailboxSource.validateFolder(root))
        XCTAssertThrowsError(try BookmarkedFolderMailboxSource.validateFolder(folder.deletingLastPathComponent()))
        XCTAssertThrowsError(try BookmarkedFolderMailboxSource.validateFolder(remote))
        let sync = folder.appendingPathComponent("Sync")
        try FileManager.default.createDirectory(at: sync, withIntermediateDirectories: true)
        XCTAssertThrowsError(try BookmarkedFolderMailboxSource.validateFolder(sync))

        try FileManager.default.removeItem(at: remote)
        XCTAssertThrowsError(try BookmarkedFolderMailboxSource.validateFolder(folder))
        try Data().write(to: remote)
        XCTAssertThrowsError(try BookmarkedFolderMailboxSource.validateFolder(folder))
    }

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
