import Foundation
import XCTest
@testable import YachiyoRemoteKit

/// A connection end to end against a scripted desktop: handshake negotiation, push delivery
/// before and during the greeting, and timeouts.
final class RemoteSessionTests: XCTestCase {
    private let desktopPrivateKey = NoiseKeyPair.generatePrivateKey()
    private let endpoint = URL(string: "ws://desktop.test/remote/v1")!
    private let identity = RemoteClientIdentity(staticPrivateKey: NoiseKeyPair.generatePrivateKey(), deviceName: "Test", appVersion: "1")

    private func connect(_ channel: FakeDesktopChannel) async throws -> RemoteClient {
        try await RemoteClient.connect(endpoint: endpoint, desktopKey: NoiseKeyPair.publicKey(forPrivate: desktopPrivateKey),
                                       identity: identity, channelFactory: { _ in channel })
    }

    /// Answers `events.subscribe` with a replay of `count` events ahead of the reply, which is
    /// what desktops before the subscribe-first change do.
    private func replayingDesktop(count: Int, handshakePayload: [String: Any]? = nil, streamDeflate: Bool = false) -> FakeDesktopChannel {
        FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey, handshakePayload: handshakePayload, streamDeflate: streamDeflate) { method, _, _ in
            switch method {
            case "remote.hello":
                return [["ok": true, "value": remoteHelloJSON()]]
            case "events.subscribe":
                return (1 ... count).map { eventPushJSON(seq: $0) }
                    + [["ok": true, "value": ["epoch": "epoch", "headSeq": count, "resumed": true]]]
            default:
                return [["ok": true, "value": method]]
            }
        }
    }

    // T0.1: a resume backlog larger than the push buffer used to overflow and close the socket
    // before the subscribe reply, replaying the same backlog forever.
    func testReplayLargerThanThePushBufferIsAppliedAndTheGreetingCompletes() async throws {
        let channel = replayingDesktop(count: 300)
        let client = try await connect(channel)
        defer { client.close() }
        XCTAssertTrue(client.features.isEmpty, "an old desktop answers with an empty payload")
        let collector = PushCollector(cursor: ResumeCursor(epoch: "epoch", seq: 0))
        let applied = expectation(description: "every replayed event applied")
        let input = collector.subscribeInput
        // The consumer lags: the whole backlog (and the subscribe reply behind it) arrives
        // before it takes the first push, so the buffer must hold the socket, not drop.
        collector.start(client, until: 300, reached: applied, startDelay: .milliseconds(150))

        let greeting = try await client.greet(subscribe: input, timeout: .seconds(5))
        await fulfillment(of: [applied], timeout: 5)
        XCTAssertEqual(collector.applied, Array(1 ... 300))
        XCTAssertFalse(collector.accept(greeting.subscription), "a resumed stream needs no refetch")
        XCTAssertEqual(collector.cursor, ResumeCursor(epoch: "epoch", seq: 300), "accept keeps the cursor the replay advanced")
        XCTAssertEqual(greeting.hello.deviceName, "Mac")
        XCTAssertFalse(channel.isClosed)
        XCTAssertEqual(Set(channel.sentMethods), ["remote.hello", "events.subscribe"])
    }

    func testNegotiatedHandshakeHelloAndStreamDeflateSkipTheHelloRoundTrip() async throws {
        let channel = replayingDesktop(count: 300, handshakePayload: [
            "compression": "gzip",
            "features": ["handshake-hello", "event-batch", "stream-deflate"],
            "hello": remoteHelloJSON(epoch: "handshake-epoch"),
        ], streamDeflate: true)
        let client = try await connect(channel)
        defer { client.close() }
        XCTAssertEqual(client.features, ["handshake-hello", "event-batch", "stream-deflate"])
        XCTAssertTrue(client.codec.gzip)
        XCTAssertTrue(client.codec.streamDeflate)
        let collector = PushCollector(cursor: ResumeCursor(epoch: "epoch", seq: 0))
        let applied = expectation(description: "every replayed event applied")
        collector.start(client, until: 300, reached: applied)

        let greeting = try await client.greet(subscribe: collector.subscribeInput, timeout: .seconds(5))
        await fulfillment(of: [applied], timeout: 5)
        XCTAssertEqual(greeting.hello.epoch, "handshake-epoch")
        XCTAssertEqual(channel.sentMethods, ["events.subscribe"])
        XCTAssertEqual(collector.applied, Array(1 ... 300))
    }

    func testHandshakeHelloWithAnotherProtocolVersionIsAMismatch() async throws {
        let channel = replayingDesktop(count: 1, handshakePayload: [
            "features": ["handshake-hello"], "hello": remoteHelloJSON(protocolVersion: 2),
        ])
        let client = try await connect(channel)
        defer { client.close() }
        do {
            _ = try await client.greet(subscribe: RemoteEventsSubscribeInput(resumeFrom: nil, threadIds: []))
            XCTFail("expected a protocol mismatch")
        } catch let error as RemoteCallError {
            XCTAssertEqual(error.name, "RemoteProtocolVersionMismatch")
        }
        XCTAssertTrue(channel.sentMethods.isEmpty)
    }

    func testTheHandshakeOffersFeaturesAndCompression() async throws {
        let offered = OfferRecorder()
        let channel = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey)
        let recording = RecordingHandshakeChannel(inner: channel, desktopPrivateKey: desktopPrivateKey, recorder: offered)
        let client = try await RemoteClient.connect(endpoint: endpoint, desktopKey: NoiseKeyPair.publicKey(forPrivate: desktopPrivateKey),
                                                    identity: identity, channelFactory: { _ in recording })
        client.close()
        let payload = try XCTUnwrap(offered.payload)
        XCTAssertEqual(payload.features, ["handshake-hello", "event-batch", "stream-deflate"])
        XCTAssertEqual(payload.compression, ["gzip"])
        XCTAssertEqual(payload.app, "yachiyo-ios")
    }

    // Backpressure: nothing is dropped and the socket stays open while the consumer is behind;
    // the reply queued behind the pushes arrives once they are consumed.
    func testAFullPushBufferPausesReceivingInsteadOfClosing() async throws {
        let slow = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey) { method, _, _ in
            (1 ... 8).map { eventPushJSON(seq: $0) } + [["ok": true, "value": method]]
        }
        let client = try await connectWithCapacity(slow, capacity: 2)
        defer { client.close() }
        let reply = Task { try await client.callRaw("threads.list", input: [:]) }
        // Longer than the call timeout: waiting on our own consumer is not desktop silence.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(slow.isClosed, "a full buffer must not close the connection")
        var delivered: [Int] = []
        for await push in client.pushes {
            delivered.append(try XCTUnwrap(push.seq))
            if delivered.count == 8 { break }
        }
        XCTAssertEqual(delivered, Array(1 ... 8))
        let value = try await reply.value
        XCTAssertEqual(String(data: value, encoding: .utf8), "\"threads.list\"")
    }

    private func connectWithCapacity(_ channel: FakeDesktopChannel, capacity: Int) async throws -> RemoteClient {
        // `connect` builds the client with the default capacity; re-wrap the negotiated channel.
        let noise = try NoiseInitiator(pattern: .ik, prologue: Data("yachiyo-remote/v1".utf8), staticPrivateKey: identity.staticPrivateKey,
                                       remoteStaticKey: NoiseKeyPair.publicKey(forPrivate: desktopPrivateKey))
        try await channel.send(Data([0x01]) + noise.writeMessage1(payload: Data("{}".utf8)))
        _ = try noise.readMessage2(try await channel.receive())
        return RemoteClient(channel: channel, transport: try noise.split(), callTimeout: .milliseconds(100), pushBufferCapacity: capacity)
    }

    // T2.6: the call timeout measures silence, not total duration.
    func testFramesArrivingKeepASlowCallAlive() async throws {
        let holder = ChannelHolder()
        let channel = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey) { method, id, _ in
            if method == "files.get" {
                Task {
                    // 600 ms in total, never 150 ms without a frame.
                    for seq in 1 ... 12 {
                        try? await Task.sleep(for: .milliseconds(50))
                        try? holder.channel?.deliver(eventPushJSON(seq: seq))
                    }
                    try? holder.channel?.deliver(["kind": "rpc:response", "id": id, "ok": true, "value": "file"])
                }
                return []
            }
            return [["ok": true, "value": method]]
        }
        holder.channel = channel
        let noise = try NoiseInitiator(pattern: .ik, prologue: Data("yachiyo-remote/v1".utf8), staticPrivateKey: identity.staticPrivateKey,
                                       remoteStaticKey: NoiseKeyPair.publicKey(forPrivate: desktopPrivateKey))
        try await channel.send(Data([0x01]) + noise.writeMessage1(payload: Data("{}".utf8)))
        _ = try noise.readMessage2(try await channel.receive())
        let client = RemoteClient(channel: channel, transport: try noise.split(), callTimeout: .milliseconds(150))
        defer { client.close() }
        let drain = Task { for await _ in client.pushes {} }
        defer { drain.cancel() }
        let started = ContinuousClock.now
        let value: String = try await client.call("files.get", ["id": "f"])
        XCTAssertEqual(value, "file")
        XCTAssertGreaterThan(started.duration(to: .now), .milliseconds(450))
        XCTAssertFalse(channel.isClosed)
    }

    func testBytesOfALargeMessageStillArrivingKeepTheCallAlive() async throws {
        let holder = ChannelHolder()
        let channel = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey) { _, id, _ in
            Task {
                for _ in 1 ... 12 {
                    try? await Task.sleep(for: .milliseconds(50))
                    holder.channel?.addReceivedBytes(64 * 1024)
                }
                try? holder.channel?.deliver(["kind": "rpc:response", "id": id, "ok": true, "value": "large"])
            }
            return []
        }
        holder.channel = channel
        let noise = try NoiseInitiator(pattern: .ik, prologue: Data("yachiyo-remote/v1".utf8), staticPrivateKey: identity.staticPrivateKey,
                                       remoteStaticKey: NoiseKeyPair.publicKey(forPrivate: desktopPrivateKey))
        try await channel.send(Data([0x01]) + noise.writeMessage1(payload: Data("{}".utf8)))
        _ = try noise.readMessage2(try await channel.receive())
        let client = RemoteClient(channel: channel, transport: try noise.split(), callTimeout: .milliseconds(150))
        defer { client.close() }
        let value: String = try await client.call("files.get", ["id": "f"])
        XCTAssertEqual(value, "large")
    }

    // T2.6: a push from a newer desktop that this build cannot decode is skipped; the rest of
    // the stream (and the connection) continues.
    func testUndecodablePushesAreSkippedWithoutClosing() async throws {
        let channel = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey)
        let client = try await connect(channel)
        defer { client.close() }
        try channel.deliver(eventPushJSON(seq: 1, type: "future.event"))
        try channel.deliver(["kind": "rpc:event", "payload": [
            "type": "batch", "epoch": "epoch", "timestamp": "2026-09-25T00:00:00.000Z",
            "items": [["seq": 2, "event": ["type": "future.event"]],
                      ["seq": 3, "event": ["type": "thread.invalidated", "threadId": "t3"]]],
        ]])
        try channel.deliver(["kind": "rpc:event", "payload": ["type": "resync", "epoch": "epoch", "seq": 4, "reason": "future-reason"]])
        try channel.deliver(["kind": "rpc:event", "payload": ["type": "future-push", "epoch": "epoch"]])
        try channel.deliver(eventPushJSON(seq: 5))

        var iterator = client.pushes.makeAsyncIterator()
        let batch = await iterator.next()
        XCTAssertEqual(batch?.type, .batch)
        XCTAssertEqual(batch?.items?.map(\.seq), [3])
        let resync = await iterator.next()
        XCTAssertEqual(resync?.type, .resync)
        XCTAssertEqual(resync?.seq, 4)
        let last = await iterator.next()
        XCTAssertEqual(last?.seq, 5)
        let value = try await client.callRaw("still.open", input: [:])
        XCTAssertEqual(String(data: value, encoding: .utf8), "\"still.open\"")
    }

    func testResponsesDecodeTypedValuesAndErrors() async throws {
        let channel = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey) { method, _, input in
            switch method {
            case "echo": return [["ok": true, "value": input ?? NSNull()]]
            case "nothing": return [["ok": true]]
            default: return [["ok": false, "error": ["name": "RemoteValidationError", "message": "bad"]]]
            }
        }
        let client = try await connect(channel)
        defer { client.close() }
        let echoed: [String: String] = try await client.call("echo", ["path": "a/b"])
        XCTAssertEqual(echoed, ["path": "a/b"])
        let nothing: String? = try await client.call("nothing", [String: String]())
        XCTAssertNil(nothing)
        do {
            let _: String = try await client.call("fails", [String: String]())
            XCTFail("expected an error response")
        } catch let error as RemoteCallError {
            XCTAssertEqual(error, RemoteCallError(name: "RemoteValidationError", message: "bad"))
        }
    }

    func testStartedCallsAreSentInOrder() async throws {
        let channel = FakeDesktopChannel(url: endpoint, responderKey: desktopPrivateKey)
        let client = try await connect(channel)
        defer { client.close() }
        let calls = try (0 ..< 6).map { try client.start("chunk.\($0)", [String: String](), as: String.self) }
        for (index, call) in calls.enumerated() {
            let value = try await call.value()
            XCTAssertEqual(value, "chunk.\(index)")
        }
        XCTAssertEqual(channel.sentMethods, (0 ..< 6).map { "chunk.\($0)" })
    }
}

private final class ChannelHolder: @unchecked Sendable {
    var channel: FakeDesktopChannel?
}

private final class OfferRecorder: @unchecked Sendable {
    var payload: RemoteHandshakeClientPayload?
}

/// Decrypts handshake message 1 with the desktop key to inspect the phone's offer.
private final class RecordingHandshakeChannel: WebSocketChannel, @unchecked Sendable {
    let inner: FakeDesktopChannel
    let desktopPrivateKey: Data
    let recorder: OfferRecorder

    init(inner: FakeDesktopChannel, desktopPrivateKey: Data, recorder: OfferRecorder) {
        self.inner = inner
        self.desktopPrivateKey = desktopPrivateKey
        self.recorder = recorder
    }

    func send(_ data: Data) async throws {
        if recorder.payload == nil {
            let payload = try NoiseResponder(staticPrivateKey: desktopPrivateKey).readMessage1(data.dropFirst())
            recorder.payload = try JSONDecoder().decode(RemoteHandshakeClientPayload.self, from: payload)
        }
        try await inner.send(data)
    }

    func receive() async throws -> Data { try await inner.receive() }
    func close() { inner.close() }
}
