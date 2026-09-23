import Foundation

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

/// One authenticated, encrypted connection to a desktop: Noise handshake, then JSON-RPC in
/// `RpcMessage` frames (see packages/shared/src/rpc/rpcTransport.ts).
public final class RemoteClient: @unchecked Sendable {
    private let channel: any WebSocketChannel
    private let transport: NoiseTransport
    private let lock = NSLock()
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var outbound: [Data] = []
    private var sending = false
    private var closed = false
    private var grantContinuation: CheckedContinuation<PairingGrant, Error>?
    private var receivedGrant: PairingGrant?
    private let pushContinuation: AsyncStream<RemotePush>.Continuation
    private let closeContinuation: AsyncStream<Error?>.Continuation
    public let pushes: AsyncStream<RemotePush>
    /// Yields once when the connection ends, with the error that ended it (nil when closed locally).
    public let closures: AsyncStream<Error?>

    init(channel: any WebSocketChannel, transport: NoiseTransport) {
        self.channel = channel
        self.transport = transport
        (pushes, pushContinuation) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
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
                let hello = try JSONSerialization.data(withJSONObject: [
                    "deviceName": identity.deviceName,
                    "app": "yachiyo-ios",
                    "version": identity.appVersion,
                ])
                try await channel.send(Data([mode.rawValue]) + initiator.writeMessage1(payload: hello))
                _ = try initiator.readMessage2(try await channel.receive())
                try Task.checkCancellation()
                return RemoteClient(channel: channel, transport: try initiator.split())
            } catch {
                channel.close()
                throw error
            }
        } onCancel: {
            // Task cancellation must wake a blocked handshake receive/send.
            channel.close()
        }
    }

    /// Calls a facade method with a JSON-encodable input and decodes its result.
    public func call<Output: Decodable>(_ method: String, _ input: some Encodable, as _: Output.Type = Output.self) async throws -> Output {
        let raw = try await callRaw(method, input: JSONSerialization.jsonObject(with: JSONEncoder().encode(input)))
        return try JSONDecoder().decode(Output.self, from: raw)
    }

    public func callRaw(_ method: String, input: Any) async throws -> Data {
        let id: Int = lock.withLock {
            defer { nextId += 1 }
            return nextId
        }
        let message: [String: Any] = ["kind": "rpc:request", "id": id, "method": method, "args": [input]]
        let plaintext = try JSONSerialization.data(withJSONObject: message)
        guard plaintext.count <= remoteMaxMessageBytes else { throw NoiseError.messageTooLarge }
        return try await withCheckedThrowingContinuation { continuation in
            let (rejected, startSending): (Bool, Bool) = lock.withLock {
                if closed { return (true, false) }
                pending[id] = continuation
                outbound.append(plaintext)
                if sending { return (false, false) }
                sending = true
                return (false, true)
            }
            if rejected {
                continuation.resume(throwing: WebSocketChannelError.closed(code: 1000))
                return
            }
            if startSending { Task { await self.sendLoop() } }
        }
    }

    /// Noise nonces are implicit: encryption and delivery must share one FIFO, including
    /// across the suspension in send. Separate per-call Tasks can reorder encrypted frames.
    private func sendLoop() async {
        while let plaintext = lock.withLock({ () -> Data? in
            guard !closed, !outbound.isEmpty else {
                sending = false
                return nil
            }
            return outbound.removeFirst()
        }) {
            do {
                try await channel.send(transport.encrypt(plaintext))
            } catch {
                fail(error)
                channel.close()
                return
            }
        }
    }

    /// Waits for the pairing grant that follows the first call on a pairing connection.
    public func pairingGrant() async throws -> PairingGrant {
        try await withCheckedThrowingContinuation { continuation in
            let grant: PairingGrant? = lock.withLock {
                if let receivedGrant { return receivedGrant }
                grantContinuation = continuation
                return nil
            }
            if let grant { continuation.resume(returning: grant) }
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
                try handle(try transport.decrypt(frame))
            } catch {
                fail(error)
                return
            }
        }
    }

    private func handle(_ plaintext: Data) throws {
        guard let message = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              let kind = message["kind"] as? String
        else { return }
        switch kind {
        case "rpc:response":
            guard let id = message["id"] as? Int else { return }
            let continuation = lock.withLock { pending.removeValue(forKey: id) }
            if message["ok"] as? Bool == true {
                let value = message["value"] ?? NSNull()
                continuation?.resume(returning: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
            } else {
                let error = message["error"] as? [String: Any]
                continuation?.resume(throwing: RemoteCallError(
                    name: error?["name"] as? String ?? "RemoteInternalError",
                    message: error?["message"] as? String ?? "Unknown error"
                ))
            }
        case "rpc:event":
            guard let payload = message["payload"] as? [String: Any] else { return }
            if payload["type"] as? String == "pairing.granted" {
                guard let pairingId = payload["pairingId"] as? String,
                      let secret = (payload["mailboxSecret"] as? String).flatMap(Base64URL.decode)
                else { return }
                let grant = PairingGrant(pairingId: pairingId, mailboxSecret: secret)
                let continuation: CheckedContinuation<PairingGrant, Error>? = lock.withLock {
                    receivedGrant = grant
                    defer { grantContinuation = nil }
                    return grantContinuation
                }
                continuation?.resume(returning: grant)
                return
            }
            let data = try JSONSerialization.data(withJSONObject: payload)
            pushContinuation.yield(try JSONDecoder().decode(RemotePush.self, from: data))
        default:
            return
        }
    }

    private func fail(_ error: Error?) {
        let (waiting, grantWaiter): ([CheckedContinuation<Data, Error>], CheckedContinuation<PairingGrant, Error>?) = lock.withLock {
            if closed { return ([], nil) }
            closed = true
            defer {
                pending.removeAll()
                outbound.removeAll()
                sending = false
                grantContinuation = nil
            }
            return (Array(pending.values), grantContinuation)
        }
        let reason = error ?? WebSocketChannelError.closed(code: 1000)
        for continuation in waiting { continuation.resume(throwing: reason) }
        grantWaiter?.resume(throwing: reason)
        pushContinuation.finish()
        closeContinuation.yield(error)
        closeContinuation.finish()
    }
}
