import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class RemoteClientTests: XCTestCase {
    func testConcurrentCallsDoNotOvertakeASuspendedSend() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let first = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        let second = Task { try await client.callRaw("second", input: [:]) }
        // The channel deliberately suspends its first send before delivering the frame.
        // Starting another send here would deliver nonce 1 before nonce 0.
        await fulfillment(of: [channel.overlappingSend], timeout: 0.2)
        channel.releaseFirstSend()
        let firstResult = try await first.value
        let secondResult = try await second.value
        XCTAssertEqual(String(data: firstResult, encoding: .utf8), "\"first\"")
        XCTAssertEqual(String(data: secondResult, encoding: .utf8), "\"second\"")
    }

    func testSendFailureResumesPendingCallsAndRejectsLaterCalls() async throws {
        let channel = SuspendedSendChannel(sendError: .unexpectedTextFrame)
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let first = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        let second = Task { try await client.callRaw("second", input: [:]) }
        await fulfillment(of: [channel.overlappingSend], timeout: 0.2)
        channel.releaseFirstSend()
        for task in [first, second] {
            do {
                _ = try await task.value
                XCTFail("Send failure must reject pending calls")
            } catch {
                XCTAssertEqual(error as? WebSocketChannelError, .unexpectedTextFrame)
            }
        }
        do {
            _ = try await client.callRaw("later", input: [:])
            XCTFail("Failed connection must reject later calls")
        } catch {
            XCTAssertEqual(error as? WebSocketChannelError, .closed(code: 1000))
        }
    }

    func testCloseResumesCallsWhileSendIsSuspended() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        let first = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        let second = Task { try await client.callRaw("second", input: [:]) }
        client.close()
        for task in [first, second] {
            do {
                _ = try await task.value
                XCTFail("Closed calls must fail")
            } catch {
                XCTAssertEqual(error as? WebSocketChannelError, .closed(code: 1000))
            }
        }
    }
}

private final class SuspendedSendChannel: WebSocketChannel, @unchecked Sendable {
    let firstSendStarted = XCTestExpectation(description: "first send suspended")
    let overlappingSend: XCTestExpectation = {
        let expectation = XCTestExpectation(description: "no overlapping encrypted sends")
        expectation.isInverted = true
        return expectation
    }()
    let clientTransport = NoiseTransport(
        send: NoiseCipherState(key: Data(repeating: 1, count: 32)),
        receive: NoiseCipherState(key: Data(repeating: 2, count: 32)), handshakeHash: Data()
    )
    private let peer = NoiseTransport(
        send: NoiseCipherState(key: Data(repeating: 2, count: 32)),
        receive: NoiseCipherState(key: Data(repeating: 1, count: 32)), handshakeHash: Data()
    )
    private let lock = NSLock()
    private var first = true
    private var suspended: CheckedContinuation<Void, Never>?
    private var closed = false
    private let sendError: WebSocketChannelError?
    private let replies: AsyncThrowingStream<Data, Error>
    private let replyContinuation: AsyncThrowingStream<Data, Error>.Continuation
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator

    init(sendError: WebSocketChannelError? = nil) {
        self.sendError = sendError
        (replies, replyContinuation) = AsyncThrowingStream.makeStream()
        iterator = replies.makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        let isFirst = lock.withLock {
            defer { first = false }
            return first
        }
        if isFirst {
            await withCheckedContinuation { continuation in
                lock.withLock {
                    if closed { continuation.resume() } else { suspended = continuation }
                }
                firstSendStarted.fulfill()
            }
        } else if lock.withLock({ suspended != nil }) {
            overlappingSend.fulfill()
        }
        guard !lock.withLock({ closed }) else { throw WebSocketChannelError.closed(code: 1000) }
        if let sendError { throw sendError }
        let request = try JSONSerialization.jsonObject(with: peer.decrypt(data)) as! [String: Any]
        let reply: [String: Any] = ["kind": "rpc:response", "id": request["id"]!, "ok": true, "value": request["method"]!]
        replyContinuation.yield(try peer.encrypt(JSONSerialization.data(withJSONObject: reply)))
    }

    func receive() async throws -> Data {
        guard let reply = try await iterator.next() else { throw WebSocketChannelError.closed(code: 1000) }
        return reply
    }

    func releaseFirstSend() {
        let continuation = lock.withLock {
            defer { suspended = nil }
            return suspended
        }
        continuation?.resume()
    }

    func close() {
        lock.withLock { closed = true }
        releaseFirstSend()
        replyContinuation.finish(throwing: WebSocketChannelError.closed(code: 1000))
    }
}
