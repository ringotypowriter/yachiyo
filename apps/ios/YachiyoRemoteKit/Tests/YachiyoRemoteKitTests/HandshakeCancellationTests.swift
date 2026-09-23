import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class HandshakeCancellationTests: XCTestCase {
    private let identity = RemoteClientIdentity(
        staticPrivateKey: Data(repeating: 7, count: 32), deviceName: "Test", appVersion: "1"
    )
    private let desktopKey = Data(repeating: 9, count: 32)
    private let endpoint = URL(string: "ws://desktop.invalid/remote/v1")!

    func testConnectCancellationClosesBlockedSendAndReceive() async {
        for blockSend in [true, false] {
            await assertCancellation(blockSend: blockSend, pairing: false)
        }
    }

    func testPairCancellationClosesBlockedSendAndReceive() async {
        for blockSend in [true, false] {
            await assertCancellation(blockSend: blockSend, pairing: true)
        }
    }

    private func assertCancellation(blockSend: Bool, pairing: Bool) async {
        let channel = BlockedHandshakeChannel(blockSend: blockSend)
        defer { channel.close() }
        let completed = expectation(description: "cancelled handshake completes")
        let task = Task {
            defer { completed.fulfill() }
            do {
                let client: RemoteClient
                if pairing {
                    client = try await RemoteClient.pair(endpoint: endpoint, desktopKey: desktopKey,
                        token: Data(repeating: 3, count: 32), identity: identity, channelFactory: { _ in channel })
                } else {
                    client = try await RemoteClient.connect(endpoint: endpoint, desktopKey: desktopKey,
                        identity: identity, channelFactory: { _ in channel })
                }
                client.close()
                XCTFail("Cancellation must not return an authenticated client")
            } catch {
                // Closing the socket may surface its close error rather than CancellationError.
                XCTAssertTrue(error is CancellationError || error as? WebSocketChannelError == .closed(code: 1000))
            }
        }
        await fulfillment(of: [channel.blocked], timeout: 2)
        task.cancel()
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertTrue(channel.isClosed)
        // Cleanup also releases the fake if the cancellation handler regresses, so tests do not hang.
        channel.close()
        await task.value
    }

    func testConnectorCancellationDoesNotTryNextEndpointOrMailbox() async {
        let channel = BlockedHandshakeChannel(blockSend: false)
        defer { channel.close() }
        let mailbox = UnexpectedMailbox()
        let connector = DesktopConnector(identity: identity, channelFactory: { _ in channel }, mailbox: mailbox)
        let completed = expectation(description: "cancelled connector completes")
        let task = Task {
            defer { completed.fulfill() }
            do {
                let (client, _) = try await connector.connect(desktop)
                client.close()
                XCTFail("Cancelled connector must fail")
            } catch {
                XCTAssertTrue(error is CancellationError)
            }
        }
        await fulfillment(of: [channel.blocked], timeout: 2)
        task.cancel()
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertTrue(channel.isClosed)
        XCTAssertEqual(channel.sendCount, 1, "Cancellation must not dial the second endpoint")
        XCTAssertEqual(mailbox.readCount, 0)
        channel.close()
        await task.value
    }

    func testPairingConnectorCancellationDoesNotTryNextEndpoint() async throws {
        let channel = BlockedHandshakeChannel(blockSend: false)
        defer { channel.close() }
        let connector = DesktopConnector(identity: identity, channelFactory: { _ in
            channel.recordAttempt()
            return channel
        })
        let payload = try JSONDecoder().decode(RemotePairingPayload.self, from: Data("""
        {"v":1,"remoteDeviceId":"desktop","deviceName":"Mac",
         "desktopKey":"\(Base64URL.encode(desktopKey))","token":"\(Base64URL.encode(Data(repeating: 3, count: 32)))",
         "endpoints":[{"kind":"lan","url":"ws://desktop.invalid/remote/v1"},
                      {"kind":"lan","url":"ws://second.invalid/remote/v1"}],
         "expiresAt":"2099-01-01T00:00:00.000Z"}
        """.utf8))
        let completed = expectation(description: "cancelled pairing completes")
        let task = Task {
            defer { completed.fulfill() }
            do {
                let (client, _, _) = try await connector.pair(payload)
                client.close()
                XCTFail("Cancelled pairing must not succeed")
            } catch {
                XCTAssertTrue(error is CancellationError)
            }
        }
        await fulfillment(of: [channel.blocked], timeout: 2)
        task.cancel()
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertTrue(channel.isClosed)
        XCTAssertEqual(channel.attemptCount, 1, "Cancellation must not dial another pairing endpoint")
        channel.close()
        await task.value
    }

    func testConnectorTimeoutClosesBlockedHandshake() async {
        let channel = BlockedHandshakeChannel(blockSend: false)
        defer { channel.close() }
        let connector = DesktopConnector(identity: identity, channelFactory: { _ in channel }, attemptTimeout: .milliseconds(50))
        var singleEndpoint = desktop
        singleEndpoint.endpoints = Array(singleEndpoint.endpoints.prefix(1))
        let completed = expectation(description: "handshake timeout completes")
        let task = Task {
            defer { completed.fulfill() }
            do {
                let (client, _) = try await connector.connect(singleEndpoint)
                client.close()
                XCTFail("Silent handshake must time out")
            } catch let error as DesktopUnreachable {
                XCTAssertEqual((error.lastError as? URLError)?.code, .timedOut)
            } catch {
                XCTFail("Unexpected error: \(error)")
            }
        }
        await fulfillment(of: [channel.blocked, completed], timeout: 2)
        XCTAssertTrue(channel.isClosed)
        channel.close()
        await task.value
    }

    private var desktop: PairedDesktop {
        PairedDesktop(remoteDeviceId: "desktop", pairingId: "pairing", deviceName: "Mac",
            desktopKey: desktopKey, mailboxSecret: Data(repeating: 1, count: 32), endpoints: [
                StoredEndpoint(kind: "lan", url: endpoint.absoluteString),
                StoredEndpoint(kind: "lan", url: "ws://second.invalid/remote/v1"),
            ])
    }
}

/// Deliberately ignores task cancellation: only closing the channel releases the I/O.
private final class BlockedHandshakeChannel: WebSocketChannel, @unchecked Sendable {
    let blocked = XCTestExpectation(description: "handshake I/O suspended")
    private let blockSend: Bool
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var closed = false
    private var sends = 0
    private var attempts = 0
    var attemptCount: Int { lock.withLock { attempts } }
    func recordAttempt() { lock.withLock { attempts += 1 } }
    var isClosed: Bool { lock.withLock { closed } }
    var sendCount: Int { lock.withLock { sends } }

    init(blockSend: Bool) { self.blockSend = blockSend }

    func send(_: Data) async throws {
        lock.withLock { sends += 1 }
        if blockSend { _ = try await suspend() }
        if isClosed { throw WebSocketChannelError.closed(code: 1000) }
    }

    func receive() async throws -> Data { try await suspend() }

    private func suspend() async throws -> Data {
        try await withCheckedThrowingContinuation { waiting in
            lock.withLock {
                if closed { waiting.resume(throwing: WebSocketChannelError.closed(code: 1000)) }
                else { continuation = waiting }
            }
            blocked.fulfill()
        }
    }

    func close() {
        let waiting = lock.withLock {
            closed = true
            defer { continuation = nil }
            return continuation
        }
        waiting?.resume(throwing: WebSocketChannelError.closed(code: 1000))
    }
}

private final class UnexpectedMailbox: MailboxSource, @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    var readCount: Int { lock.withLock { reads } }
    func read(mailboxId: String) async throws -> Data? {
        lock.withLock { reads += 1 }
        return nil
    }
}
