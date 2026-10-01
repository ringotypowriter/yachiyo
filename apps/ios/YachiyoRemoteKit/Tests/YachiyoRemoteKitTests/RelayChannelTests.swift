import Foundation
import XCTest
@testable import YachiyoRemoteKit

private final class RelayTestSocket: RelaySocket, @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [RelayFrame] = []
    private var waiter: CheckedContinuation<RelayFrame, Error>?
    private var sentFrames: [RelayFrame] = []
    private var closes = 0
    var receivedByteCount: Int64? { nil }
    var closeCount: Int { lock.withLock { closes } }
    var sent: [RelayFrame] { lock.withLock { sentFrames } }

    func deliver(_ frame: RelayFrame) {
        let waiting: CheckedContinuation<RelayFrame, Error>? = lock.withLock {
            if let waiter { self.waiter = nil; return waiter }
            frames.append(frame)
            return nil
        }
        waiting?.resume(returning: frame)
    }

    func send(_ frame: RelayFrame) async throws { lock.withLock { sentFrames.append(frame) } }
    func receive() async throws -> RelayFrame {
        try await withCheckedThrowingContinuation { continuation in
            let ready: RelayFrame? = lock.withLock {
                if !frames.isEmpty { return frames.removeFirst() }
                if closes > 0 { return nil }
                waiter = continuation
                return nil
            }
            if let ready { continuation.resume(returning: ready) }
            else if closeCount > 0 { continuation.resume(throwing: WebSocketChannelError.closed(code: 1000)) }
        }
    }
    func close() {
        let waiting: CheckedContinuation<RelayFrame, Error>? = lock.withLock {
            closes += 1
            defer { waiter = nil }
            return waiter
        }
        waiting?.resume(throwing: WebSocketChannelError.closed(code: 1000))
    }
}

final class RelayChannelTests: XCTestCase {
    func testOpenGatesNoiseAndPongIsConsumedWhileBinaryRemainsOpaque() async throws {
        let socket = RelayTestSocket()
        let channel = RelayWebSocketChannel(socket: socket)
        let binary = Data([1, 2, 3, 4])
        let sending = Task { try await channel.send(binary) }
        await Task.yield()
        XCTAssertTrue(socket.sent.isEmpty)
        socket.deliver(.text(#"{"type":"open"}"#))
        try await sending.value
        guard case let .binary(sent)? = socket.sent.first else { return XCTFail("Noise must be raw binary") }
        XCTAssertEqual(sent, binary)
        socket.deliver(.text(#"{"type":"pong"}"#))
        socket.deliver(.binary(binary))
        let received = try await channel.receive()
        XCTAssertEqual(received, binary)
        channel.close()
        channel.close()
        XCTAssertEqual(socket.closeCount, 1)
    }

    func testUnexpectedControlRejectsAndClosesOnce() async {
        let socket = RelayTestSocket()
        let channel = RelayWebSocketChannel(socket: socket)
        socket.deliver(.text(#"{"type":"error","message":"bad token"}"#))
        do { try await channel.send(Data([1])); XCTFail("unexpected text accepted") }
        catch { XCTAssertEqual(error as? WebSocketChannelError, .unexpectedTextFrame) }
        channel.close()
        XCTAssertEqual(socket.closeCount, 1)
    }

    func testEachRelayDialUsesNewSessionURLWithoutCredentialInURL() throws {
        let endpoint = StoredEndpoint(kind: "relay", url: "wss://relay.example/v1/phones/host/phone/ws", token: String(repeating: "A", count: 43))
        let first = try XCTUnwrap(endpoint.dialURL)
        let second = try XCTUnwrap(endpoint.dialURL)
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(first.path.hasPrefix("/v1/phones/host/phone/"))
        XCTAssertTrue(first.path.hasSuffix("/ws"))
        XCTAssertEqual(first.path.split(separator: "/").count, 6)
        XCTAssertFalse(first.absoluteString.contains(endpoint.token!))
        XCTAssertNil(StoredEndpoint(kind: "relay", url: endpoint.url, token: "wrong").dialURL)
    }
}
