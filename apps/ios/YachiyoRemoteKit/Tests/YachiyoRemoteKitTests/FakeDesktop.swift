import Foundation
import XCTest
import zlib
@testable import YachiyoRemoteKit

/// Desktop side of Noise_IK for tests; mirrors `NoiseInitiator` (and the desktop's responder).
final class NoiseResponder {
    private let staticPrivate: Data
    private var chainingKey: Data
    private var hash: Data
    private var cipher = NoiseCipherState(key: nil)
    private var remoteEphemeral = Data()
    private var remoteStatic = Data()

    init(staticPrivateKey: Data) throws {
        staticPrivate = staticPrivateKey
        let name = Data(NoisePattern.ik.protocolName.utf8)
        hash = name.count <= NoisePrimitives.hashLength ? name + Data(count: NoisePrimitives.hashLength - name.count) : NoisePrimitives.sha256(name)
        chainingKey = hash
        mixHash(Data("yachiyo-remote/v1".utf8))
        mixHash(try NoisePrimitives.publicKey(forPrivate: staticPrivateKey))
    }

    func readMessage1(_ message: Data) throws -> Data {
        let bytes = Data(message)
        remoteEphemeral = bytes.prefix(32)
        mixHash(remoteEphemeral)
        mixKey(try NoisePrimitives.dh(privateKey: staticPrivate, publicKey: remoteEphemeral))
        remoteStatic = try decryptAndHash(bytes.subdata(in: 32 ..< 80))
        mixKey(try NoisePrimitives.dh(privateKey: staticPrivate, publicKey: remoteStatic))
        return try decryptAndHash(bytes.subdata(in: 80 ..< bytes.count))
    }

    func writeMessage2(payload: Data) throws -> Data {
        let ephemeral = NoiseKeyPair.generatePrivateKey()
        let ephemeralPublic = try NoisePrimitives.publicKey(forPrivate: ephemeral)
        mixHash(ephemeralPublic)
        mixKey(try NoisePrimitives.dh(privateKey: ephemeral, publicKey: remoteEphemeral))
        mixKey(try NoisePrimitives.dh(privateKey: ephemeral, publicKey: remoteStatic))
        return ephemeralPublic + (try encryptAndHash(payload))
    }

    func split() -> NoiseTransport {
        let keys = NoisePrimitives.noiseHKDF(chainingKey: chainingKey, ikm: Data(), outputs: 2)
        return NoiseTransport(send: NoiseCipherState(key: keys[1].prefix(32)), receive: NoiseCipherState(key: keys[0].prefix(32)), handshakeHash: hash)
    }

    private func mixHash(_ data: Data) { hash = NoisePrimitives.sha256(hash, data) }

    private func mixKey(_ ikm: Data) {
        let outputs = NoisePrimitives.noiseHKDF(chainingKey: chainingKey, ikm: ikm, outputs: 2)
        chainingKey = outputs[0]
        cipher = NoiseCipherState(key: outputs[1].prefix(32))
    }

    private func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(ad: hash, plaintext: plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    private func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ad: hash, ciphertext: ciphertext)
        mixHash(ciphertext)
        return plaintext
    }
}

/// The desktop's `stream-deflate` sender: one raw deflate stream, Z_SYNC_FLUSH per message.
final class TestStreamDeflater {
    private let stream = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)

    init() {
        stream.initialize(to: z_stream())
        precondition(deflateInit2_(stream, 1, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK)
    }

    deinit {
        deflateEnd(stream)
        stream.deinitialize(count: 1)
        stream.deallocate()
    }

    func encode(_ raw: Data) -> Data {
        var output = Data([0x02])
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        raw.withUnsafeBytes { input in
            stream.pointee.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress)
            stream.pointee.avail_in = uInt(raw.count)
            repeat {
                chunk.withUnsafeMutableBytes { buffer in
                    stream.pointee.next_out = buffer.bindMemory(to: Bytef.self).baseAddress
                    stream.pointee.avail_out = uInt(buffer.count)
                    _ = deflate(stream, Z_SYNC_FLUSH)
                }
                output.append(contentsOf: chunk.prefix(chunk.count - Int(stream.pointee.avail_out)))
            } while stream.pointee.avail_out == 0
        }
        return output
    }
}

func remoteHelloJSON(epoch: String = "epoch", protocolVersion: Int = 1) -> [String: Any] {
    ["activeRunEnterBehavior": "enter-steers", "appVersion": "1", "deviceName": "Mac",
     "epoch": epoch, "protocolVersion": protocolVersion, "remoteDeviceId": "desktop"]
}

func eventPushJSON(seq: Int, epoch: String = "epoch", type: String = "thread.invalidated") -> [String: Any] {
    ["kind": "rpc:event",
     "payload": ["epoch": epoch, "seq": seq, "type": "event", "timestamp": "2026-09-25T00:00:00.000Z",
                 "event": ["type": type, "threadId": "thread-\(seq)"]]]
}

/// A scripted desktop behind one WebSocket: completes the Noise handshake (after `acceptDelay`,
/// or never when `hangs`), then answers requests through `respond`, which returns the
/// messages to send back in order.
final class FakeDesktopChannel: WebSocketChannel, @unchecked Sendable {
    typealias Responder = @Sendable (_ method: String, _ id: Int, _ input: Any?) -> [[String: Any]]

    let url: URL
    let didClose = XCTestExpectation(description: "fake desktop channel closed")
    private let responderKey: Data
    private let handshakePayload: Data
    private let acceptDelay: Duration
    private let hangs: Bool
    private let deflater: TestStreamDeflater?
    private let respond: Responder
    private let lock = NSLock()
    private var responder: NoiseResponder?
    private var transport: NoiseTransport?
    private var closed = false
    private var methods: [String] = []
    private let frames: AsyncThrowingStream<Data, Error>
    private let frameContinuation: AsyncThrowingStream<Data, Error>.Continuation
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator

    private var byteCount: Int64?
    var sentMethods: [String] { lock.withLock { methods } }
    /// Simulates a large message arriving without completing.
    func addReceivedBytes(_ count: Int64) { lock.withLock { byteCount = (byteCount ?? 0) + count } }
    var receivedByteCount: Int64? { lock.withLock { byteCount } }
    var isClosed: Bool { lock.withLock { closed } }

    init(
        url: URL,
        responderKey: Data,
        handshakePayload: [String: Any]? = nil,
        acceptDelay: Duration = .zero,
        hangs: Bool = false,
        streamDeflate: Bool = false,
        respond: @escaping Responder = { method, _, _ in
            method == "remote.hello" ? [["ok": true, "value": remoteHelloJSON()]] : [["ok": true, "value": method]]
        }
    ) {
        self.url = url
        self.responderKey = responderKey
        self.handshakePayload = handshakePayload.map { try! JSONSerialization.data(withJSONObject: $0) } ?? Data()
        self.acceptDelay = acceptDelay
        self.hangs = hangs
        deflater = streamDeflate ? TestStreamDeflater() : nil
        self.respond = respond
        (frames, frameContinuation) = AsyncThrowingStream.makeStream()
        iterator = frames.makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        guard !isClosed else { throw WebSocketChannelError.closed(code: 1000) }
        if let transport = lock.withLock({ self.transport }) {
            let plaintext = try RemoteMessageCodec(gzip: true).decode(transport.decrypt(data))
            let request = try JSONSerialization.jsonObject(with: plaintext) as! [String: Any]
            let method = request["method"] as! String
            let id = request["id"] as! Int
            lock.withLock { methods.append(method) }
            for message in respond(method, id, (request["args"] as? [Any])?.first) {
                var framed = message
                if framed["kind"] == nil {
                    framed["kind"] = "rpc:response"
                    framed["id"] = id
                }
                try deliver(framed)
            }
            return
        }
        // Handshake message 1: mode byte, then the Noise message.
        let noise = try NoiseResponder(staticPrivateKey: responderKey)
        _ = try noise.readMessage1(data.dropFirst())
        lock.withLock { responder = noise }
        if hangs { return }
        let reply = try noise.writeMessage2(payload: handshakePayload)
        let transport = noise.split()
        let delay = acceptDelay
        Task {
            if delay > .zero { try? await Task.sleep(for: delay) }
            self.lock.withLock { self.transport = transport }
            self.frameContinuation.yield(reply)
        }
    }

    func receive() async throws -> Data {
        guard let frame = try await iterator.next() else { throw WebSocketChannelError.closed(code: 1000) }
        return frame
    }

    /// Sends one message (a push or a response) to the phone.
    func deliver(_ message: [String: Any]) throws {
        guard let transport = lock.withLock({ self.transport }) else { return }
        let plaintext = try JSONSerialization.data(withJSONObject: message)
        let encoded = lock.withLock { deflater?.encode(plaintext) } ?? plaintext
        frameContinuation.yield(try transport.encrypt(encoded))
    }

    func close() {
        let wasClosed = lock.withLock {
            defer { closed = true }
            return closed
        }
        if !wasClosed { didClose.fulfill() }
        frameContinuation.finish(throwing: WebSocketChannelError.closed(code: 1000))
    }
}

/// Hands out a fake per URL and records the dial order.
final class FakeDesktopNetwork: @unchecked Sendable {
    private let lock = NSLock()
    private var dialed: [String] = []
    private var channels: [String: FakeDesktopChannel] = [:]
    private let make: @Sendable (URL) -> any WebSocketChannel

    init(make: @escaping @Sendable (URL) -> any WebSocketChannel) {
        self.make = make
    }

    var dialOrder: [String] { lock.withLock { dialed } }
    func channel(for url: String) -> FakeDesktopChannel? { lock.withLock { channels[url] } }

    var factory: WebSocketChannelFactory {
        { [self] url in
            let channel = make(url)
            lock.withLock {
                dialed.append(url.absoluteString)
                if let fake = channel as? FakeDesktopChannel { channels[url.absoluteString] = fake }
            }
            return channel
        }
    }
}

/// Collects pushes on a background task, the way `DesktopLink` does before the greeting ends.
final class PushCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var tracker: EventCursorTracker
    private var appliedSeqs: [Int] = []
    private var resyncs = 0
    private var task: Task<Void, Never>?

    init(cursor: ResumeCursor?) {
        tracker = EventCursorTracker(cursor: cursor)
    }

    var applied: [Int] { lock.withLock { appliedSeqs } }
    var cursor: ResumeCursor? { lock.withLock { tracker.cursor } }
    var subscribeInput: RemoteEventsSubscribeInput { lock.withLock { tracker.subscribeInput(threadIds: []) } }

    func accept(_ output: RemoteEventsSubscribeOutput) -> Bool {
        lock.withLock { tracker.accept(output) }
    }

    /// `startDelay` models a consumer that is busy elsewhere when the backlog arrives.
    func start(_ client: RemoteClient, until count: Int, reached: XCTestExpectation? = nil, startDelay: Duration = .zero) {
        task = Task {
            if startDelay > .zero { try? await Task.sleep(for: startDelay) }
            for await push in client.pushes {
                let done: Bool = lock.withLock {
                    for decision in tracker.observe(push) {
                        switch decision {
                        case let .apply(_, seq): appliedSeqs.append(seq)
                        case .resync: resyncs += 1
                        case .skip: break
                        }
                    }
                    return appliedSeqs.count >= count
                }
                if done {
                    reached?.fulfill()
                    return
                }
            }
        }
    }

    func stop() { task?.cancel() }
}
