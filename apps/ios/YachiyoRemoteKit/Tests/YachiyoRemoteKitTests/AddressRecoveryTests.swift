import Foundation
import XCTest
@testable import YachiyoRemoteKit

private struct RecoverySource: MailboxSource {
    let box: Data?
    let error: MailboxReadError?
    func read(mailboxId: String) async throws -> Data? {
        if let error { throw error }
        return box
    }
}

final class AddressRecoveryTests: XCTestCase {
    private func desktop() -> PairedDesktop {
        PairedDesktop(remoteDeviceId: "desktop", pairingId: "pairing", deviceName: "Mac",
            desktopKey: Data(repeating: 1, count: 32), mailboxSecret: Data(repeating: 2, count: 32),
            mailboxCounter: 3,
            endpoints: [StoredEndpoint(kind: "tunnel", url: "wss://old.example/remote/v1"),
                        StoredEndpoint(kind: "lan", url: "ws://192.168.1.2:47831/remote/v1")],
            cursor: ResumeCursor(epoch: "epoch", seq: 12))
    }

    private func connector(_ source: MailboxSource? = nil) -> DesktopConnector {
        DesktopConnector(identity: RemoteClientIdentity(staticPrivateKey: NoiseKeyPair.generatePrivateKey(), deviceName: "Test", appVersion: "1"), mailbox: source)
    }

    func testNormalizesHostHTTPAndIPv6() throws {
        for (input, expected) in [
            (" localhost:47831 ", "ws://localhost:47831/remote/v1"),
            ("192.168.1.2:47831", "ws://192.168.1.2:47831/remote/v1"),
            ("new.example", "wss://new.example/remote/v1"),
            ("https://new.example", "wss://new.example/remote/v1"),
            ("http://mac.local/", "ws://mac.local/remote/v1"),
            ("[::1]:47831", "ws://[::1]:47831/remote/v1"),
            ("wss://new.example/remote/v1", "wss://new.example/remote/v1")
        ] { XCTAssertEqual(try DesktopAddress.normalize(input), expected) }
    }

    func testRejectsUnsafeAndPairingAddresses() {
        for input in ["", "ws://user:password@host", "wss://host#secret", "wss://host?token=x", "https://host/pair", "yachiyo://pair?data=x", "ftp://host", "wss://host/remote/v1/extra", "host:0", "host:65536", "ws://host/%72emote/v1", "two hosts"] {
            XCTAssertThrowsError(try DesktopAddress.normalize(input), input)
        }
    }

    func testManualReplacementPreservesIdentitySecretsAndCursor() throws {
        let original = desktop()
        let updated = try DesktopAddress.replacingPrimary(in: original, address: "https://new.example")
        XCTAssertEqual(updated.endpoints.map(\.url), ["wss://new.example/remote/v1", original.endpoints[1].url])
        XCTAssertEqual(updated.desktopKey, original.desktopKey)
        XCTAssertEqual(updated.mailboxSecret, original.mailboxSecret)
        XCTAssertEqual(updated.pairingId, original.pairingId)
        XCTAssertEqual(updated.mailboxCounter, original.mailboxCounter)
        XCTAssertEqual(updated.cursor, original.cursor)
        XCTAssertNotNil(updated.lastAddressUpdateAt)
        XCTAssertEqual(updated.lastAddressUpdateURL, updated.endpoints.first?.url)
    }

    func testOldRecordsDecodeWithoutDiagnosticMetadata() throws {
        let encoded = try JSONEncoder().encode(desktop())
        let decoded = try JSONDecoder().decode(PairedDesktop.self, from: encoded)
        XCTAssertNil(decoded.lastAddressUpdateAt)
        XCTAssertNil(decoded.lastAddressUpdateURL)
        XCTAssertNil(decoded.lastSuccessfulURL)
        XCTAssertEqual(decoded, desktop())
    }

    func testExplicitRecoveryOutcomes() async {
        let (_, notConfigured) = await connector().recover(desktop())
        XCTAssertEqual(notConfigured.outcome, .notConfigured)
        let (_, notSelected) = await connector(RecoverySource(box: nil, error: .notConfigured)).recover(desktop())
        XCTAssertEqual(notSelected.outcome, .notConfigured)
        let (_, absent) = await connector(RecoverySource(box: nil, error: nil)).recover(desktop())
        XCTAssertEqual(absent.outcome, .notFound)
        XCTAssertNotNil(absent.checkedAt)
        let (_, denied) = await connector(RecoverySource(box: nil, error: .accessDenied)).recover(desktop())
        XCTAssertEqual(denied.outcome, .failed)
        XCTAssertTrue(denied.detail?.contains("denied") == true)
        let (_, stale) = await connector(RecoverySource(box: nil, error: .staleBookmark)).recover(desktop())
        XCTAssertTrue(stale.detail?.contains("stale") == true)
        let (unchanged, invalid) = await connector(RecoverySource(box: Data([1, 2, 3]), error: nil)).recover(desktop())
        XCTAssertEqual(invalid.outcome, .failed)
        XCTAssertEqual(unchanged, desktop())
    }

    func testAuthenticatedRecoveryPreservesIdentityAndRejectsReplayOrWrongDevice() async throws {
        let fixture = try Fixtures.json("mailbox.json") as! [String: Any]
        let source = RecoverySource(box: Data(hex: fixture["box"] as! String), error: nil)
        var original = desktop()
        original.mailboxSecret = Data(hex: fixture["mailboxSecret"] as! String)
        let (_, mismatch) = await connector(source).recover(original)
        XCTAssertEqual(mismatch.outcome, .failed)
        original.remoteDeviceId = (fixture["plaintext"] as! [String: Any])["remoteDeviceId"] as! String
        let (updated, status) = await connector(source).recover(original)
        XCTAssertEqual(status.outcome, .updated)
        XCTAssertEqual(updated.mailboxCounter, 5)
        XCTAssertEqual(updated.desktopKey, original.desktopKey)
        XCTAssertEqual(updated.pairingId, original.pairingId)
        XCTAssertEqual(updated.cursor, original.cursor)
        let (replayed, stale) = await connector(source).recover(updated)
        XCTAssertEqual(stale.outcome, .unchanged)
        XCTAssertEqual(replayed, updated)
        var sameEndpoints = original
        sameEndpoints.endpoints = updated.endpoints
        sameEndpoints.lastAddressUpdateAt = Date(timeIntervalSince1970: 123)
        sameEndpoints.lastAddressUpdateURL = updated.endpoints.first?.url
        let (accepted, same) = await connector(source).recover(sameEndpoints)
        XCTAssertEqual(same.outcome, .unchanged)
        XCTAssertEqual(accepted.mailboxCounter, 5)
        XCTAssertEqual(accepted.lastAddressUpdateAt, sameEndpoints.lastAddressUpdateAt)
        XCTAssertEqual(accepted.lastAddressUpdateURL, sameEndpoints.lastAddressUpdateURL)
    }
}
