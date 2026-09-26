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

    private func makeFolder() throws -> (root: URL, folder: URL, file: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let folder = root.appendingPathComponent("Yachiyo")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("Remote"), withIntermediateDirectories: true)
        return (root, folder, folder.appendingPathComponent("Remote/box-id.box"))
    }

    func testAnUnchangedMailboxFileIsNotReadAgain() async throws {
        let (root, folder, file) = try makeFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("first".utf8).write(to: file)
        // Whole seconds, so restoring the date below round-trips exactly.
        let modified = Date(timeIntervalSince1970: 1_790_000_000)
        try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: file.path)
        let source = BookmarkedFolderMailboxSource(bookmark: try BookmarkedFolderMailboxSource.makeBookmark(for: folder))
        let first = try await source.read(mailboxId: "box-id")
        XCTAssertEqual(first, Data("first".utf8))

        // Same modification date: the previous bytes are reused without touching the file.
        try Data("other".utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: file.path)
        let second = try await source.read(mailboxId: "box-id")
        XCTAssertEqual(second, Data("first".utf8))

        try FileManager.default.setAttributes([.modificationDate: modified.addingTimeInterval(60)], ofItemAtPath: file.path)
        let third = try await source.read(mailboxId: "box-id")
        XCTAssertEqual(third, Data("other".utf8))
        let missing = try await source.read(mailboxId: "absent")
        XCTAssertNil(missing)
    }

    func testAStalledMailboxReadGivesUpAtTheDeadline() async throws {
        let (root, folder, file) = try makeFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("box".utf8).write(to: file)
        let source = BookmarkedFolderMailboxSource(bookmark: try BookmarkedFolderMailboxSource.makeBookmark(for: folder), readDeadline: 0.2)
        // A coordinated writer holding the file blocks coordinated readers, like a stalled download.
        let writing = expectation(description: "writer holds the file")
        let release = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            NSFileCoordinator().coordinate(writingItemAt: file, options: [], error: nil) { _ in
                writing.fulfill()
                release.wait()
            }
        }
        await fulfillment(of: [writing], timeout: 2)
        defer { release.signal() }
        let started = ContinuousClock.now
        do {
            _ = try await source.read(mailboxId: "box-id")
            XCTFail("expected the read to time out")
        } catch MailboxReadError.timedOut {
            XCTAssertLessThan(started.duration(to: .now), .seconds(1))
        }
    }
}
