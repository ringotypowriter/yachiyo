import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class RemoteClientTests: XCTestCase {
    func testPairingGreetingCancellationClosesStalledHello() async {
        await assertPairingGreetingCancellation(replyToHello: false)
    }

    func testPairingGreetingCancellationClosesMissingGrant() async {
        await assertPairingGreetingCancellation(replyToHello: true)
    }

    private func assertPairingGreetingCancellation(replyToHello: Bool) async {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let connector = DesktopConnector(identity: RemoteClientIdentity(
            staticPrivateKey: Data(repeating: 7, count: 32), deviceName: "Test", appVersion: "1"
        ))
        let completed = expectation(description: "cancelled pairing greeting finishes")
        let task = Task {
            defer { completed.fulfill() }
            do {
                _ = try await connector.pairingGreeting(client: client)
                XCTFail("Cancelled pairing greeting must not succeed")
            } catch {
                XCTAssertTrue(error is CancellationError || error as? WebSocketChannelError == .closed(code: 1000))
            }
        }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        if replyToHello {
            channel.releaseFirstSend()
            await fulfillment(of: [channel.helloReplySent], timeout: 2)
        }
        task.cancel()
        await fulfillment(of: [channel.didClose, completed], timeout: 2)
        client.close()
        await task.value
    }

    func testPairingGreetingTimesOutWhenHelloSucceedsButGrantIsMissing() async {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let connector = DesktopConnector(identity: RemoteClientIdentity(
            staticPrivateKey: Data(repeating: 7, count: 32), deviceName: "Test", appVersion: "1"
        ), attemptTimeout: .milliseconds(100))
        let completed = expectation(description: "missing pairing grant times out")
        let task = Task {
            defer { completed.fulfill() }
            do {
                _ = try await connector.pairingGreeting(client: client)
                XCTFail("Missing grant must time out")
            } catch {
                XCTAssertEqual((error as? URLError)?.code, .timedOut)
            }
        }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        channel.releaseFirstSend()
        await fulfillment(of: [channel.helloReplySent, channel.didClose, completed], timeout: 2)
        client.close()
        await task.value
    }

    func testPairingGrantAfterCloseFailsInsteadOfWaitingForever() async {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        client.close()
        let completed = expectation(description: "closed grant wait fails")
        Task {
            defer { completed.fulfill() }
            do {
                _ = try await client.pairingGrant()
                XCTFail("A closed pairing connection must reject grant waits")
            } catch {
                XCTAssertEqual(error as? WebSocketChannelError, .closed(code: 1000))
            }
        }
        await fulfillment(of: [completed], timeout: 2)
    }

    func testCompressedConcurrentCallsPreserveFIFOAndDecodeResponses() async throws {
        let codec = RemoteMessageCodec(gzip: true)
        let channel = SuspendedSendChannel(codec: codec)
        let client = RemoteClient(channel: channel, transport: channel.clientTransport, codec: codec)
        defer { client.close() }
        let firstMethod = String(repeating: "first", count: 500)
        let secondMethod = String(repeating: "second", count: 500)
        let first = Task { try await client.callRaw(firstMethod, input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        let second = Task { try await client.callRaw(secondMethod, input: [:]) }
        await fulfillment(of: [channel.overlappingSend], timeout: 0.2)
        channel.releaseFirstSend()
        let firstResult = try await first.value
        let secondResult = try await second.value
        XCTAssertEqual(try JSONDecoder().decode(String.self, from: firstResult), firstMethod)
        XCTAssertEqual(try JSONDecoder().decode(String.self, from: secondResult), secondMethod)
        XCTAssertEqual(channel.compressedSendCount, 2)
    }

    func testInvalidCompressedReplyClosesAndRejectsPendingCalls() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport, codec: RemoteMessageCodec(gzip: true))
        defer { client.close() }
        let pending = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        try channel.receiveInvalidCompressedFrame()
        do {
            _ = try await pending.value
            XCTFail("Invalid gzip must fail pending calls")
        } catch {
            XCTAssertEqual(error as? RemoteMessageCodecError, .invalidGzip)
        }
        await fulfillment(of: [channel.didClose], timeout: 2)
        do {
            _ = try await client.callRaw("later", input: [:])
            XCTFail("Closed connection must reject later calls")
        } catch {
            XCTAssertEqual(error as? WebSocketChannelError, .closed(code: 1000))
        }
    }

    func testOversizedLocalRequestDoesNotSendOrDisruptPendingCalls() async throws {
        let codec = RemoteMessageCodec(gzip: true)
        let channel = SuspendedSendChannel(codec: codec)
        let client = RemoteClient(channel: channel, transport: channel.clientTransport, codec: codec)
        defer { client.close() }
        let pending = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        do {
            _ = try await client.callRaw("oversized", input: ["content": String(repeating: "x", count: remoteMaxMessageBytes)])
            XCTFail("Oversized local requests must be rejected before enqueueing")
        } catch {
            XCTAssertEqual(error as? RemoteRequestError, .messageTooLarge)
        }
        XCTAssertEqual(channel.sendCount, 1)
        channel.releaseFirstSend()
        let result = try await pending.value
        XCTAssertEqual(String(data: result, encoding: .utf8), "\"first\"")
        let later = try await client.callRaw("later", input: [:])
        XCTAssertEqual(String(data: later, encoding: .utf8), "\"later\"")
        XCTAssertEqual(channel.sendCount, 2)
    }

    func testOversizedIncomingFrameRemainsTransportErrorForPendingCall() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let pending = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        channel.receiveOversizedFrame()
        do {
            _ = try await pending.value
            XCTFail("Oversized incoming frames must fail pending calls")
        } catch {
            XCTAssertEqual(error as? NoiseError, .messageTooLarge)
            XCTAssertNil(error as? RemoteRequestError)
        }
    }

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

    func testCancellingQueuedCallDropsItsFrameWithoutClosingConnection() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let first = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        let queued = Task { try await client.callRaw("cancelled", input: [:]) }
        // Keep the first send blocked while the second call enqueues.
        try await Task.sleep(for: .milliseconds(30))
        queued.cancel()
        do {
            _ = try await queued.value
            XCTFail("Cancelled queued call must fail promptly")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        channel.releaseFirstSend()
        let firstResult = try await first.value
        XCTAssertEqual(String(data: firstResult, encoding: .utf8), "\"first\"")
        let later = try await client.callRaw("later", input: [:])
        XCTAssertEqual(String(data: later, encoding: .utf8), "\"later\"")
        XCTAssertEqual(channel.sentMethods, ["first", "later"])
    }

    func testAlreadyCancelledCallerNeverQueuesAFrame() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.callRaw("cancelled", input: [:])
        }
        do {
            _ = try await cancelled.value
            XCTFail("Already cancelled call must fail")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(channel.sendCount, 0)
        let later = Task { try await client.callRaw("later", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        channel.releaseFirstSend()
        let result = try await later.value
        XCTAssertEqual(String(data: result, encoding: .utf8), "\"later\"")
    }

    func testCancellingInFlightCallDoesNotDropEncryptedSendOrCloseConnection() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport)
        defer { client.close() }
        let first = Task { try await client.callRaw("mutation", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        first.cancel()
        do {
            _ = try await first.value
            XCTFail("Cancelled caller must stop waiting")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        channel.releaseFirstSend()
        let later = try await client.callRaw("later", input: [:])
        XCTAssertEqual(String(data: later, encoding: .utf8), "\"later\"")
        XCTAssertEqual(channel.sentMethods, ["mutation", "later"])
    }

    func testSilentSocketTimesOutAndReleasesAllPendingCalls() async {
        let channel = SuspendedSendChannel(suppressReplies: true)
        let client = RemoteClient(channel: channel, transport: channel.clientTransport, callTimeout: .milliseconds(120))
        defer { client.close() }
        let first = Task { try await client.callRaw("first", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        let second = Task { try await client.callRaw("second", input: [:]) }
        channel.releaseFirstSend()
        let completed = expectation(description: "both silent calls terminate")
        completed.expectedFulfillmentCount = 2
        for task in [first, second] {
            Task {
                defer { completed.fulfill() }
                do {
                    _ = try await task.value
                    XCTFail("Silent socket must time out")
                } catch {
                    XCTAssertEqual((error as? URLError)?.code, .timedOut)
                }
            }
        }
        await fulfillment(of: [channel.didClose, completed], timeout: 2)
        XCTAssertEqual(channel.sentMethods, ["first", "second"])
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

    func testPushOverflowClosesSocketAndReplaysFromLastAppliedCursor() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport, pushBufferCapacity: 2)
        defer { client.close() }
        try channel.receivePush(seq: 1, type: "message.started")
        try channel.receivePush(seq: 2, type: "message.delta")
        try channel.receivePush(seq: 3, type: "message.completed")

        // No consumer is running yet: the third push must not evict either earlier event.
        await fulfillment(of: [channel.didClose], timeout: 2)
        var tracker = EventCursorTracker()
        var delivered: [Int] = []
        for await push in client.pushes {
            delivered.append(try XCTUnwrap(push.seq))
            _ = tracker.observe(push)
        }
        XCTAssertEqual(delivered, [1, 2])
        XCTAssertEqual(tracker.cursor?.seq, 2)
        XCTAssertEqual(tracker.subscribeInput(threadIds: []).resumeFrom?.seq, 2)
        var closureIterator = client.closures.makeAsyncIterator()
        let closeReason = await closureIterator.next()
        XCTAssertEqual(closeReason as? RemotePushBufferError, .overflow)
        do {
            _ = try await client.callRaw("later", input: [:])
            XCTFail("Overflowed socket must reject later calls")
        } catch {
            XCTAssertEqual(error as? WebSocketChannelError, .closed(code: 1000))
        }

        // A new socket can replay the omitted event from the last applied cursor.
        let replayChannel = SuspendedSendChannel()
        let replay = RemoteClient(channel: replayChannel, transport: replayChannel.clientTransport, pushBufferCapacity: 2)
        defer { replay.close() }
        try replayChannel.receivePush(seq: 3, type: "message.completed")
        var iterator = replay.pushes.makeAsyncIterator()
        let recovered = await iterator.next()
        XCTAssertEqual(recovered?.seq, 3)
        if let recovered { _ = tracker.observe(recovered) }
        XCTAssertEqual(tracker.cursor?.seq, 3)
    }

    func testPushOverflowFailsPendingCallWithoutSendingAnotherNoiseFrame() async throws {
        let channel = SuspendedSendChannel()
        let client = RemoteClient(channel: channel, transport: channel.clientTransport, pushBufferCapacity: 1)
        defer { client.close() }
        let pending = Task { try await client.callRaw("pending", input: [:]) }
        await fulfillment(of: [channel.firstSendStarted], timeout: 2)
        try channel.receivePush(seq: 1, type: "message.delta")
        try channel.receivePush(seq: 2, type: "message.completed")
        await fulfillment(of: [channel.didClose], timeout: 2)
        do {
            _ = try await pending.value
            XCTFail("Overflow must fail in-flight calls")
        } catch {
            XCTAssertEqual(error as? RemotePushBufferError, .overflow)
        }
        XCTAssertEqual(channel.sendCount, 1)
        var delivered: [Int] = []
        for await push in client.pushes { delivered.append(try XCTUnwrap(push.seq)) }
        XCTAssertEqual(delivered, [1])
    }
}

private final class SuspendedSendChannel: WebSocketChannel, @unchecked Sendable {
    let helloReplySent = XCTestExpectation(description: "hello replied without a grant")
    let didClose = XCTestExpectation(description: "channel closed")
    private let codec: RemoteMessageCodec
    private var compressedSends = 0
    var compressedSendCount: Int { lock.withLock { compressedSends } }
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
    private var sends = 0
    var sendCount: Int { lock.withLock { sends } }
    private var methods: [String] = []
    var sentMethods: [String] { lock.withLock { methods } }
    private var first = true
    private var suspended: CheckedContinuation<Void, Never>?
    private var closed = false
    private let sendError: WebSocketChannelError?
    private let suppressReplies: Bool
    private let replies: AsyncThrowingStream<Data, Error>
    private let replyContinuation: AsyncThrowingStream<Data, Error>.Continuation
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator

    init(sendError: WebSocketChannelError? = nil, codec: RemoteMessageCodec = .legacy, suppressReplies: Bool = false) {
        self.sendError = sendError
        self.suppressReplies = suppressReplies
        self.codec = codec
        (replies, replyContinuation) = AsyncThrowingStream.makeStream()
        iterator = replies.makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        let isFirst = lock.withLock {
            sends += 1
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
        let encoded = try peer.decrypt(data)
        if encoded.first == 1 { lock.withLock { compressedSends += 1 } }
        let request = try JSONSerialization.jsonObject(with: codec.decode(encoded)) as! [String: Any]
        lock.withLock { methods.append(request["method"] as! String) }
        if suppressReplies { return }
        let isHello = request["method"] as? String == "remote.hello"
        let value: Any = isHello ? [
            "activeRunEnterBehavior": "enter-steers", "appVersion": "1", "deviceName": "Mac",
            "epoch": "epoch", "protocolVersion": 1, "remoteDeviceId": "desktop",
        ] as [String: Any] : request["method"]!
        let reply: [String: Any] = ["kind": "rpc:response", "id": request["id"]!, "ok": true, "value": value]
        replyContinuation.yield(try peer.encrypt(codec.encode(JSONSerialization.data(withJSONObject: reply))))
        if isHello { helloReplySent.fulfill() }
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

    func receiveOversizedFrame() {
        replyContinuation.yield(Data(repeating: 0, count: remoteMaxMessageBytes + 17))
    }

    func receiveInvalidCompressedFrame() throws {
        replyContinuation.yield(try peer.encrypt(Data([1, 0, 0])))
    }

    func receivePush(seq: Int, type: String) throws {
        let push: [String: Any] = [
            "kind": "rpc:event",
            "payload": ["epoch": "epoch", "seq": seq, "type": "event",
                        "event": ["type": type, "threadId": "thread", "messageId": "message", "delta": "chunk"]],
        ]
        replyContinuation.yield(try peer.encrypt(codec.encode(JSONSerialization.data(withJSONObject: push))))
    }

    func close() {
        let wasClosed = lock.withLock {
            defer { closed = true }
            return closed
        }
        if !wasClosed { didClose.fulfill() }
        releaseFirstSend()
        replyContinuation.finish(throwing: WebSocketChannelError.closed(code: 1000))
    }
}
