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
                    XCTAssertFalse(log.all.contains("wss://quiet-fox.trycloudflare.com/remote/v1"))
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
        // The known endpoints and the mailbox read overlap, so only the first dial is ordered.
        XCTAssertEqual(log.all.first, "wss://old-owl.trycloudflare.com/remote/v1")
        XCTAssertEqual(Set(log.all), [
            "wss://old-owl.trycloudflare.com/remote/v1",
            "ws://192.168.1.20:47831/remote/v1",
            "wss://quiet-fox.trycloudflare.com/remote/v1",
        ])
        XCTAssertEqual(log.all.count, 3)
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

    // MARK: Endpoint racing (T2.3)

    private let desktopPrivateKey = NoiseKeyPair.generatePrivateKey()
    private let tunnel = "wss://tunnel.example/remote/v1"
    private let lan = "ws://192.168.1.20:47831/remote/v1"

    private func racingDesktop(lastSuccessfulURL: String? = nil) throws -> PairedDesktop {
        var desktop = PairedDesktop(remoteDeviceId: "0123456789abcdef0123456789abcdef", pairingId: "p1", deviceName: "Mac",
                                    desktopKey: try NoiseKeyPair.publicKey(forPrivate: desktopPrivateKey),
                                    mailboxSecret: Data(repeating: 1, count: 32),
                                    endpoints: [StoredEndpoint(kind: "tunnel", url: tunnel), StoredEndpoint(kind: "lan", url: lan)])
        desktop.lastSuccessfulURL = lastSuccessfulURL
        return desktop
    }

    private func connector(_ network: FakeDesktopNetwork, mailbox: MailboxSource? = nil, stagger: Duration = .milliseconds(250)) -> DesktopConnector {
        DesktopConnector(identity: RemoteClientIdentity(staticPrivateKey: NoiseKeyPair.generatePrivateKey(), deviceName: "Test", appVersion: "1"),
                         channelFactory: network.factory, mailbox: mailbox, attemptTimeout: .seconds(5), staggerDelay: stagger)
    }

    func testTheLastWorkingEndpointIsDialedFirst() async throws {
        let key = desktopPrivateKey
        let tunnel = tunnel
        let network = FakeDesktopNetwork { url in
            FakeDesktopChannel(url: url, responderKey: key, hangs: url.absoluteString == tunnel)
        }
        let mailbox = CountingMailbox()
        let (client, _) = try await connector(network, mailbox: mailbox).connect(try racingDesktop(lastSuccessfulURL: lan))
        client.close()
        XCTAssertEqual(network.dialOrder, [lan], "a fast preferred endpoint wins before any other dial")
        XCTAssertEqual(mailbox.reads, 0, "a fast connect never reads the mailbox")
    }

    func testAStalledEndpointDoesNotHoldUpTheNextOne() async throws {
        let key = desktopPrivateKey
        let tunnel = tunnel
        let network = FakeDesktopNetwork { url in
            FakeDesktopChannel(url: url, responderKey: key, hangs: url.absoluteString == tunnel)
        }
        let started = ContinuousClock.now
        let progress = ProgressLog()
        let (client, _) = try await connector(network, stagger: .milliseconds(50)).connect(try racingDesktop(), observe: { progress.record($0) })
        client.close()
        XCTAssertLessThan(started.duration(to: .now), .seconds(2), "the 5 s attempt timeout must not be waited out")
        XCTAssertEqual(network.dialOrder, [tunnel, lan])
        XCTAssertEqual(progress.connected, [lan])
        let stalled = try XCTUnwrap(network.channel(for: tunnel))
        await fulfillment(of: [stalled.didClose], timeout: 2)
    }

    func testTheFirstCompletedHandshakeWinsAndTheLoserIsClosed() async throws {
        let key = desktopPrivateKey
        let tunnel = tunnel
        let network = FakeDesktopNetwork { url in
            // The tunnel is dialed first but finishes its handshake later.
            FakeDesktopChannel(url: url, responderKey: key, acceptDelay: url.absoluteString == tunnel ? .milliseconds(400) : .zero)
        }
        let (client, _) = try await connector(network, stagger: .milliseconds(30)).connect(try racingDesktop())
        defer { client.close() }
        XCTAssertEqual(network.dialOrder, [tunnel, lan])
        let loser = try XCTUnwrap(network.channel(for: tunnel))
        await fulfillment(of: [loser.didClose], timeout: 2)
        XCTAssertFalse(try XCTUnwrap(network.channel(for: lan)).isClosed)
    }

    func testMailboxEndpointsJoinTheRaceWhileKnownEndpointsStall() async throws {
        let fixture = try Fixtures.json("mailbox.json") as! [String: Any]
        let key = desktopPrivateKey
        let fresh = "wss://quiet-fox.trycloudflare.com/remote/v1"
        let network = FakeDesktopNetwork { url in
            FakeDesktopChannel(url: url, responderKey: key, hangs: url.absoluteString != fresh)
        }
        var desktop = try racingDesktop()
        desktop.mailboxSecret = Data(hex: fixture["mailboxSecret"] as! String)
        desktop.mailboxCounter = 2
        let mailbox = FixtureMailbox(id: fixture["mailboxId"] as! String, box: Data(hex: fixture["box"] as! String))
        let started = ContinuousClock.now
        let (client, updated) = try await connector(network, mailbox: mailbox, stagger: .milliseconds(50)).connect(desktop)
        client.close()
        XCTAssertLessThan(started.duration(to: .now), .seconds(2), "the mailbox must not wait for the known endpoints to time out")
        XCTAssertEqual(updated.mailboxCounter, 5)
        XCTAssertEqual(updated.endpoints.map(\.url), [fresh])
        XCTAssertEqual(network.dialOrder.last, fresh)
    }
}

private final class CountingMailbox: MailboxSource, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var reads: Int { lock.withLock { count } }
    func read(mailboxId: String) async throws -> Data? {
        lock.withLock { count += 1 }
        return nil
    }
}

private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [String] = []
    var connected: [String] { lock.withLock { urls } }
    func record(_ progress: DesktopConnector.Progress) {
        if case let .connected(url) = progress { lock.withLock { urls.append(url) } }
    }
}
