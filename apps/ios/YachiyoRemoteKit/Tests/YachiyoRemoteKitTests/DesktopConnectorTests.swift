import Foundation
import XCTest
@testable import YachiyoRemoteKit

private final class UnreachableChannel: WebSocketChannel, @unchecked Sendable {
    func send(_: Data) async throws { throw URLError(.cannotConnectToHost) }
    func receive() async throws -> Data { throw URLError(.cannotConnectToHost) }
    func close() {}
}

private final class DialLog: @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [String] = []
    func record(_ url: URL) { lock.withLock { urls.append(url.absoluteString) } }
    var all: [String] { lock.withLock { urls } }
}

private struct FixtureMailbox: MailboxSource {
    let id: String
    let box: Data
    func read(mailboxId: String) async throws -> Data? { mailboxId == id ? box : nil }
}

final class DesktopConnectorTests: XCTestCase {
    func testFallsBackToMailboxEndpointsAfterEveryKnownEndpointFails() async throws {
        let fixture = try Fixtures.json("mailbox.json") as! [String: Any]
        let secret = Data(hex: fixture["mailboxSecret"] as! String)
        let recoveryReported = expectation(description: "accepted recovery reported before dialing")
        let log = DialLog()
        let connector = DesktopConnector(
            identity: RemoteClientIdentity(staticPrivateKey: NoiseKeyPair.generatePrivateKey(), deviceName: "Test", appVersion: "1"),
            channelFactory: { url in
                log.record(url)
                return UnreachableChannel()
            },
            mailbox: FixtureMailbox(id: fixture["mailboxId"] as! String, box: Data(hex: fixture["box"] as! String)),
            attemptTimeout: .seconds(2)
        )
        let desktop = PairedDesktop(
            remoteDeviceId: (fixture["plaintext"] as! [String: Any])["remoteDeviceId"] as! String,
            pairingId: "p1",
            deviceName: "Mac",
            desktopKey: Data(repeating: 9, count: 32),
            mailboxSecret: secret,
            mailboxCounter: 2,
            endpoints: [
                StoredEndpoint(kind: "tunnel", url: "wss://old-owl.trycloudflare.com/remote/v1"),
                StoredEndpoint(kind: "lan", url: "ws://192.168.1.20:47831/remote/v1"),
            ]
        )

        do {
            _ = try await connector.connect(desktop, observe: { progress in
                if case let .recovery(status, updated) = progress, status.outcome == .updated {
                    // The UI learns/persists the new target before it is dialed, not after timeout.
                    XCTAssertEqual(log.all.count, 2)
                    XCTAssertEqual(updated.mailboxCounter, 5)
                    XCTAssertNotNil(status.checkedAt)
                    XCTAssertNotNil(updated.lastAddressUpdateAt)
                    recoveryReported.fulfill()
                }
            })
            XCTFail("expected the desktop to stay unreachable")
        } catch let error as DesktopUnreachable {
            XCTAssertEqual(error.updated.mailboxCounter, 5)
            XCTAssertEqual(error.updated.endpoints.map(\.url), ["wss://quiet-fox.trycloudflare.com/remote/v1"])
        }
        await fulfillment(of: [recoveryReported], timeout: 1)
        XCTAssertEqual(log.all, [
            "wss://old-owl.trycloudflare.com/remote/v1",
            "ws://192.168.1.20:47831/remote/v1",
            "wss://quiet-fox.trycloudflare.com/remote/v1",
        ])
    }

    func testAStaleMailboxIsIgnored() async throws {
        let fixture = try Fixtures.json("mailbox.json") as! [String: Any]
        let log = DialLog()
        let connector = DesktopConnector(
            identity: RemoteClientIdentity(staticPrivateKey: NoiseKeyPair.generatePrivateKey(), deviceName: "Test", appVersion: "1"),
            channelFactory: { url in
                log.record(url)
                return UnreachableChannel()
            },
            mailbox: FixtureMailbox(id: fixture["mailboxId"] as! String, box: Data(hex: fixture["box"] as! String)),
            attemptTimeout: .seconds(2)
        )
        let desktop = PairedDesktop(
            remoteDeviceId: "0123456789abcdef0123456789abcdef",
            pairingId: "p1",
            deviceName: "Mac",
            desktopKey: Data(repeating: 9, count: 32),
            mailboxSecret: Data(hex: fixture["mailboxSecret"] as! String),
            mailboxCounter: 5,
            endpoints: [StoredEndpoint(kind: "tunnel", url: "wss://old-owl.trycloudflare.com/remote/v1")]
        )
        do {
            _ = try await connector.connect(desktop)
            XCTFail("expected failure")
        } catch let error as DesktopUnreachable {
            XCTAssertEqual(error.updated, desktop)
        }
        XCTAssertEqual(log.all, ["wss://old-owl.trycloudflare.com/remote/v1"])
    }
}
