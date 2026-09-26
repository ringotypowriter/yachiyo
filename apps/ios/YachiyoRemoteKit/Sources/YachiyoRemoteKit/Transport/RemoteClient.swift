import Foundation

/// Local request rejection before enqueueing; unlike transport errors, delivery is not ambiguous.
public enum RemoteRequestError: Error, Equatable, Sendable {
    case messageTooLarge
}

public struct RemoteCallError: Error, Equatable, Sendable {
    /// One of the desktop's `REMOTE_ERROR_NAMES`, e.g. `RemoteValidationError`.
    public let name: String
    public let message: String

    public init(name: String, message: String) {
        self.name = name
        self.message = message
    }
}

public struct PairingGrant: Equatable, Sendable {
    public let pairingId: String
    public let mailboxSecret: Data
}

public enum RemoteHandshakeMode: UInt8, Sendable {
    case connect = 0x01
    case pair = 0x02
}

/// The identity this phone presents in handshake message 1.
public struct RemoteClientIdentity: Sendable {
    public let staticPrivateKey: Data
    public let deviceName: String
    public let appVersion: String

    public init(staticPrivateKey: Data, deviceName: String, appVersion: String) {
        self.staticPrivateKey = staticPrivateKey
        self.deviceName = deviceName
        self.appVersion = appVersion
    }
}

/// A call already queued on the socket. Enqueueing is synchronous, so calls started one after
/// another are sent in that order (pipelined uploads rely on it); awaiting is separate.
public struct RemotePendingCall<Output: Decodable>: Sendable {
    fileprivate let client: RemoteClient
    fileprivate let id: Int
    fileprivate let slot: RemoteCallSlot

    /// Waits for the reply. Cancelling the waiting task cancels the call: an unsent request is
    /// dropped, a sent one is abandoned without closing the connection.
    public func value() async throws -> Output {
        let data = try await withTaskCancellationHandler {
            try await slot.wait()
        } onCancel: {
            client.cancel(id)
        }
        return try RemoteClient.decodeResponse(Output.self, from: data)
    }

    public func cancel() {
        client.cancel(id)
    }
}

/// One-shot result box: the reply may arrive before or after someone waits for it.
final class RemoteCallSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Data, Error>?
    private var waiter: CheckedContinuation<Data, Error>?

    func resolve(_ value: Result<Data, Error>) {
        let waiting: CheckedContinuation<Data, Error>? = lock.withLock {
            guard result == nil else { return nil }
            result = value
            defer { waiter = nil }
            return waiter
        }
        waiting?.resume(with: value)
    }

    func wait() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let ready: Result<Data, Error>? = lock.withLock {
                if let result { return result }
                waiter = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready) }
        }
    }
}

/// One authenticated, encrypted connection to a desktop: Noise handshake, then JSON-RPC in
/// `RpcMessage` frames (see packages/shared/src/rpc/rpcTransport.ts).
public final class RemoteClient: @unchecked Sendable {
    private struct PendingCall {
        let slot: RemoteCallSlot
        let timeout: Duration
        let enqueuedAt: ContinuousClock.Instant
    }

    private struct OutboundCall {
        let id: Int
        let plaintext: Data
    }

    private let channel: any WebSocketChannel
    private let transport: NoiseTransport
    let codec: RemoteMessageCodec
    private let inflater: RemoteStreamInflater?
    private let lock = NSLock()
    private var nextId = 1
    private var pending: [Int: PendingCall] = [:]
    private var outbound: [OutboundCall] = []
    private var outboundHead = 0
    private let callTimeout: Duration
    private var sending = false
    private var closed = false
    private var watchdogRunning = false
    private var lastInbound = ContinuousClock.now
    private var lastReceivedByteCount: Int64?
    private var receivePaused = false
    private var grantContinuation: CheckedContinuation<PairingGrant, Error>?
    private var receivedGrant: PairingGrant?
    private let closeContinuation: AsyncStream<Error?>.Continuation
    /// Pushes in receive order, with backpressure; see `RemotePushStream`.
    public let pushes: RemotePushStream
    /// Yields once when the connection ends, with the error that ended it (nil when closed locally).
    public let closures: AsyncStream<Error?>
    /// Features the desktop enabled in the handshake (`RemoteFeature`).
    public let features: Set<String>
    /// The `remote.hello` output from handshake message 2, when `handshake-hello` was negotiated.
    public let handshakeHello: RemoteHelloOutput?

    init(
        channel: any WebSocketChannel,
        transport: NoiseTransport,
        codec: RemoteMessageCodec = .legacy,
        features: Set<String> = [],
        handshakeHello: RemoteHelloOutput? = nil,
        callTimeout: Duration = .seconds(15),
        pushBufferCapacity: Int = 256
    ) {
        self.channel = channel
        self.transport = transport
        self.codec = codec
        // Created up front so a context failure surfaces as a decode error on the first 0x02.
        inflater = codec.streamDeflate ? try? RemoteStreamInflater() : nil
        self.features = features
        self.handshakeHello = handshakeHello
        self.callTimeout = callTimeout
        lastReceivedByteCount = channel.receivedByteCount
        pushes = RemotePushStream(capacity: pushBufferCapacity)
        (closures, closeContinuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
        Task { await self.receiveLoop() }
    }

    /// Reconnects an existing pairing with Noise_IK.
    public static func connect(
        endpoint: URL,
        desktopKey: Data,
        identity: RemoteClientIdentity,
        channelFactory: WebSocketChannelFactory = { URLSessionWebSocketChannel(url: $0) }
    ) async throws -> RemoteClient {
        try await open(endpoint: endpoint, mode: .connect, desktopKey: desktopKey, psk: nil, identity: identity, channelFactory: channelFactory)
    }

    /// First pairing with Noise_IKpsk2 and the QR token; the grant arrives with the first reply.
    public static func pair(
        endpoint: URL,
        desktopKey: Data,
        token: Data,
        identity: RemoteClientIdentity,
        channelFactory: WebSocketChannelFactory = { URLSessionWebSocketChannel(url: $0) }
    ) async throws -> RemoteClient {
        try await open(endpoint: endpoint, mode: .pair, desktopKey: desktopKey, psk: token, identity: identity, channelFactory: channelFactory)
    }

    private static func open(
        endpoint: URL,
        mode: RemoteHandshakeMode,
        desktopKey: Data,
        psk: Data?,
        identity: RemoteClientIdentity,
        channelFactory: WebSocketChannelFactory
    ) async throws -> RemoteClient {
        let channel = channelFactory(endpoint)
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            do {
                let initiator = try NoiseInitiator(
                    pattern: mode == .pair ? .ikpsk2 : .ik,
                    prologue: Data("yachiyo-remote/v1".utf8),
                    staticPrivateKey: identity.staticPrivateKey,
                    remoteStaticKey: desktopKey,
                    psk: psk
                )
                // Old desktops ignore `features` and answer with the legacy payload.
                let hello = try JSONEncoder().encode(RemoteHandshakeClientPayload(
                    app: "yachiyo-ios",
                    compression: ["gzip"],
                    deviceName: identity.deviceName,
                    features: RemoteFeature.offered,
                    version: identity.appVersion
                ))
                try await channel.send(Data([mode.rawValue]) + initiator.writeMessage1(payload: hello))
                let reply = try initiator.readMessage2(try await channel.receive())
                let negotiation = try RemoteHandshakeNegotiation.parse(reply: reply)
                try Task.checkCancellation()
                return RemoteClient(
                    channel: channel,
                    transport: try initiator.split(),
                    codec: negotiation.codec,
                    features: negotiation.features,
                    handshakeHello: negotiation.hello
                )
            } catch {
                channel.close()
                throw error
            }
        } onCancel: {
            // Task cancellation must wake a blocked handshake receive/send.
            channel.close()
        }
    }

    /// When a frame last arrived (or the receive loop last resumed after backpressure).
    public var lastReceivedAt: ContinuousClock.Instant { lock.withLock { lastInbound } }

    /// Calls a facade method with a JSON-encodable input and decodes its result.
    ///
    /// `timeout` is an idle timeout: it expires only when nothing has been received for that
    /// long since the call was queued, so a large transfer in progress does not trip it. On
    /// expiry the whole connection closes, because a silent socket fails every call anyway.
    public func call<Output: Decodable>(_ method: String, _ input: some Encodable, as _: Output.Type = Output.self, timeout: Duration? = nil) async throws -> Output {
        if Task.isCancelled { throw CancellationError() }
        return try await start(method, input, as: Output.self, timeout: timeout).value()
    }

    /// Queues a call now and returns a handle to await; see `RemotePendingCall`.
    public func start<Output: Decodable>(_ method: String, _ input: some Encodable, as _: Output.Type = Output.self, timeout: Duration? = nil) throws -> RemotePendingCall<Output> {
        let id = lock.withLock {
            defer { nextId += 1 }
            return nextId
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let plaintext = try encoder.encode(RequestEnvelope(id: id, method: method, input: input))
        let slot = try enqueue(id: id, plaintext: plaintext, timeout: timeout ?? callTimeout)
        return RemotePendingCall(client: self, id: id, slot: slot)
    }

    /// Untyped variant; returns the JSON of the reply's `value`.
    public func callRaw(_ method: String, input: Any) async throws -> Data {
        if Task.isCancelled { throw CancellationError() }
        let id: Int = lock.withLock {
            defer { nextId += 1 }
            return nextId
        }
        let message: [String: Any] = ["kind": "rpc:request", "id": id, "method": method, "args": [input]]
        let plaintext = try JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes])
        let slot = try enqueue(id: id, plaintext: plaintext, timeout: callTimeout)
        let data = try await withTaskCancellationHandler {
            try await slot.wait()
        } onCancel: {
            cancel(id)
        }
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return try JSONSerialization.data(withJSONObject: object?["value"] ?? NSNull(), options: [.fragmentsAllowed])
    }

    private func enqueue(id: Int, plaintext: Data, timeout: Duration) throws -> RemoteCallSlot {
        guard plaintext.count <= remoteMaxMessageBytes else { throw RemoteRequestError.messageTooLarge }
        let slot = RemoteCallSlot()
        let (startSending, startWatchdog): (Bool, Bool) = try lock.withLock {
            if closed { throw WebSocketChannelError.closed(code: 1000) }
            pending[id] = PendingCall(slot: slot, timeout: timeout, enqueuedAt: .now)
            outbound.append(OutboundCall(id: id, plaintext: plaintext))
            let startWatchdog = !watchdogRunning
            watchdogRunning = true
            if sending { return (false, startWatchdog) }
            sending = true
            return (true, startWatchdog)
        }
        if startSending { Task { await self.sendLoop() } }
        if startWatchdog { Task { await self.watchdog() } }
        return slot
    }

    func cancel(_ id: Int) {
        // The queued frame stays in `outbound`; the send loop skips ids that are no longer pending.
        let call = lock.withLock { pending.removeValue(forKey: id) }
        call?.slot.resolve(.failure(CancellationError()))
    }

    static func decodeResponse<Output: Decodable>(_: Output.Type, from data: Data) throws -> Output {
        try JSONDecoder().decode(ResponseValue<Output>.self, from: data).value
    }

    /// Noise nonces are implicit: encryption and delivery must share one FIFO, including
    /// across the suspension in send. Separate per-call Tasks can reorder encrypted frames.
    private func sendLoop() async {
        while let plaintext = lock.withLock({ () -> Data? in
            while !closed, outboundHead < outbound.count {
                let next = outbound[outboundHead]
                outboundHead += 1
                if outboundHead >= 64, outboundHead * 2 >= outbound.count {
                    outbound.removeFirst(outboundHead)
                    outboundHead = 0
                }
                // A call cancelled before its turn never reaches the wire.
                if pending[next.id] != nil { return next.plaintext }
            }
            sending = false
            return nil
        }) {
            do {
                try await channel.send(transport.encrypt(codec.encode(plaintext)))
            } catch {
                fail(error)
                channel.close()
                return
            }
        }
    }

    /// Expires calls whose connection went quiet. Runs only while calls are pending.
    private func watchdog() async {
        while true {
            let wake: ContinuousClock.Instant? = lock.withLock {
                guard !closed, !pending.isEmpty else {
                    watchdogRunning = false
                    return nil
                }
                return nextDeadlineLocked()
            }
            guard let wake else { return }
            // Re-check at least every second: a later call may carry a shorter timeout.
            let now = ContinuousClock.now
            if wake > now { try? await Task.sleep(until: min(wake, now + .seconds(1)), clock: .continuous) }
            // Bytes of a large message still arriving count as activity too.
            let received = channel.receivedByteCount
            let expired = lock.withLock {
                if let received, received != lastReceivedByteCount {
                    lastReceivedByteCount = received
                    lastInbound = .now
                }
                return !closed && !receivePaused && (nextDeadlineLocked().map { $0 <= .now } ?? false)
            }
            if expired {
                if fail(URLError(.timedOut)) { channel.close() }
                lock.withLock { watchdogRunning = false }
                return
            }
        }
    }

    private func nextDeadlineLocked() -> ContinuousClock.Instant? {
        // Waiting on our own consumer is not the desktop's silence.
        if receivePaused { return .now + (pending.values.map(\.timeout).min() ?? callTimeout) }
        return pending.values.map { max($0.enqueuedAt, lastInbound) + $0.timeout }.min()
    }

    /// Waits for the pairing grant that follows the first call on a pairing connection.
    public func pairingGrant() async throws -> PairingGrant {
        try await withCheckedThrowingContinuation { continuation in
            let result: Result<PairingGrant, Error>? = lock.withLock {
                if closed { return .failure(WebSocketChannelError.closed(code: 1000)) }
                if let receivedGrant { return .success(receivedGrant) }
                grantContinuation = continuation
                return nil
            }
            if let result { continuation.resume(with: result) }
        }
    }

    public func close() {
        channel.close()
        fail(nil)
    }

    private func receiveLoop() async {
        while true {
            do {
                let frame = try await channel.receive()
                lock.withLock { lastInbound = .now }
                let plaintext = try codec.decode(transport.decrypt(frame), stream: inflater)
                if try await !handle(plaintext) { return }
            } catch {
                fail(error)
                channel.close()
                return
            }
        }
    }

    /// Returns false once the connection has ended.
    private func handle(_ plaintext: Data) async throws -> Bool {
        // One typed pass routes the message; a response's `value` is decoded by its caller.
        switch try JSONDecoder().decode(InboundMessage.self, from: plaintext) {
        case let .response(id, error):
            let call = lock.withLock { pending.removeValue(forKey: id) }
            if let error { call?.slot.resolve(.failure(error)) } else { call?.slot.resolve(.success(plaintext)) }
        case let .grant(grant):
            let continuation: CheckedContinuation<PairingGrant, Error>? = lock.withLock {
                receivedGrant = grant
                defer { grantContinuation = nil }
                return grantContinuation
            }
            continuation?.resume(returning: grant)
        case let .push(push):
            let delivered = await pushes.enqueue(push, onPause: { lock.withLock { receivePaused = true } })
            lock.withLock {
                if receivePaused {
                    receivePaused = false
                    lastInbound = .now
                }
            }
            return delivered
        case .ignored:
            break
        }
        return true
    }

    @discardableResult
    private func fail(_ error: Error?) -> Bool {
        let result: ([PendingCall], CheckedContinuation<PairingGrant, Error>?)? = lock.withLock {
            if closed { return nil }
            closed = true
            defer {
                pending.removeAll()
                outbound.removeAll()
                outboundHead = 0
                sending = false
                grantContinuation = nil
            }
            return (Array(pending.values), grantContinuation)
        }
        guard let (waiting, grantWaiter) = result else { return false }
        let reason = error ?? WebSocketChannelError.closed(code: 1000)
        for call in waiting { call.slot.resolve(.failure(reason)) }
        grantWaiter?.resume(throwing: reason)
        pushes.finish()
        closeContinuation.yield(error)
        closeContinuation.finish()
        return true
    }
}

extension RemoteClient {
    /// `remote.hello` plus `events.subscribe` after the handshake. With `handshake-hello` (or a
    /// hello already known, e.g. from pairing) only the subscribe goes out; otherwise both are
    /// pipelined. The caller must already be draining `pushes`: the desktop may replay events
    /// ahead of the subscribe reply, and a full push buffer holds that reply back.
    public func greet(
        subscribe input: RemoteEventsSubscribeInput,
        knownHello: RemoteHelloOutput? = nil,
        timeout: Duration? = nil
    ) async throws -> (hello: RemoteHelloOutput, subscription: RemoteEventsSubscribeOutput) {
        if let known = handshakeHello ?? knownHello {
            // The RPC path lets the desktop reject a mismatched version; here the phone checks.
            guard Int(known.protocolVersion) == remoteProtocolVersion else {
                throw RemoteCallError(name: "RemoteProtocolVersionMismatch", message: "This desktop speaks remote protocol \(Int(known.protocolVersion)).")
            }
            let subscription: RemoteEventsSubscribeOutput = try await call("events.subscribe", input, timeout: timeout)
            return (known, subscription)
        }
        let hello = try start("remote.hello", HelloInput.current, as: RemoteHelloOutput.self, timeout: timeout)
        let subscribe = try start("events.subscribe", input, as: RemoteEventsSubscribeOutput.self, timeout: timeout)
        do {
            let greeting = try await hello.value()
            return (greeting, try await subscribe.value())
        } catch {
            subscribe.cancel()
            throw error
        }
    }
}

private struct RequestEnvelope<Input: Encodable>: Encodable {
    let id: Int
    let method: String
    let input: Input

    private enum CodingKeys: String, CodingKey { case kind, id, method, args }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("rpc:request", forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode(method, forKey: .method)
        var args = container.nestedUnkeyedContainer(forKey: .args)
        try args.encode(input)
    }
}

/// `{ value }` of a successful response. The desktop omits `value` for undefined results,
/// which decodes like JSON null.
private struct ResponseValue<Output: Decodable>: Decodable {
    let value: Output

    private enum CodingKeys: String, CodingKey { case value }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.value) {
            value = try container.decode(Output.self, forKey: .value)
        } else {
            value = try JSONDecoder().decode(Output.self, from: Data("null".utf8))
        }
    }
}

/// Routing view of one inbound message.
private enum InboundMessage: Decodable {
    case response(id: Int, error: RemoteCallError?)
    case push(RemotePush)
    case grant(PairingGrant)
    case ignored

    private enum CodingKeys: String, CodingKey { case kind, id, ok, error, payload }
    private struct ErrorBody: Decodable { let name: String?; let message: String? }
    private struct PayloadType: Decodable { let type: String? }
    private struct GrantPayload: Decodable { let pairingId: String; let mailboxSecret: String }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decodeIfPresent(String.self, forKey: .kind) {
        case "rpc:response":
            guard let id = try? container.decode(Int.self, forKey: .id) else { self = .ignored; return }
            if (try? container.decode(Bool.self, forKey: .ok)) == true {
                self = .response(id: id, error: nil)
            } else {
                let body = try? container.decode(ErrorBody.self, forKey: .error)
                self = .response(id: id, error: RemoteCallError(
                    name: body?.name ?? "RemoteInternalError",
                    message: body?.message ?? "Unknown error"
                ))
            }
        case "rpc:event":
            if (try? container.decode(PayloadType.self, forKey: .payload))?.type == "pairing.granted" {
                guard let payload = try? container.decode(GrantPayload.self, forKey: .payload),
                      let secret = Base64URL.decode(payload.mailboxSecret)
                else { self = .ignored; return }
                self = .grant(PairingGrant(pairingId: payload.pairingId, mailboxSecret: secret))
            } else if let push = try? container.decode(RemotePush.self, forKey: .payload) {
                self = .push(push)
            } else if let push = (try? container.decode(SalvagedPush.self, forKey: .payload))?.push {
                self = .push(push)
            } else {
                // Additive event types from a newer desktop must not close the connection. The
                // cursor does not move past it; a later event or replay skips it.
                self = .ignored
            }
        default:
            self = .ignored
        }
    }
}

/// Keeps what a push from a newer desktop still says in terms this client knows: batch items
/// that decode, and resyncs (whose reason may be new). A single unknown event is dropped.
private struct SalvagedPush: Decodable {
    let push: RemotePush?

    private enum CodingKeys: String, CodingKey { case type, epoch, seq, timestamp, items }

    private struct LossyItem: Decodable {
        let item: RemotePushBatchItem?
        init(from decoder: Decoder) throws { item = try? RemotePushBatchItem(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let epoch = try container.decode(String.self, forKey: .epoch)
        let timestamp = try? container.decode(String.self, forKey: .timestamp)
        switch try container.decode(String.self, forKey: .type) {
        case RemotePushType.batch.rawValue:
            let items = try container.decode([LossyItem].self, forKey: .items).compactMap(\.item)
            push = RemotePush(epoch: epoch, event: nil, seq: nil, timestamp: timestamp, type: .batch, items: items, reason: nil)
        case RemotePushType.resync.rawValue:
            let seq = try? container.decode(Int.self, forKey: .seq)
            push = RemotePush(epoch: epoch, event: nil, seq: seq, timestamp: timestamp, type: .resync, items: nil, reason: nil)
        default:
            push = nil
        }
    }
}
