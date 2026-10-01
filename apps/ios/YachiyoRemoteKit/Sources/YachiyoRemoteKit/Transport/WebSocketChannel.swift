import Foundation

/// A binary WebSocket as the client uses it; `URLSessionWebSocketChannel` in production,
/// in-memory pairs in tests.
public protocol WebSocketChannel: AnyObject, Sendable {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func close()
    /// Bytes received so far, including a message still arriving, when the channel can tell.
    /// Idle timeouts treat growth as progress, so one large message is not cut off midway.
    var receivedByteCount: Int64? { get }
}

extension WebSocketChannel {
    public var receivedByteCount: Int64? { nil }
}

public enum WebSocketChannelError: Error, Equatable {
    case closed(code: Int)
    case unexpectedTextFrame
    case relayUnauthorized
}

public final class URLSessionWebSocketChannel: WebSocketChannel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    public init(url: URL, session: URLSession = .shared) {
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = remoteMaxMessageBytes + 64 * 1024
        task.resume()
    }

    public func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    public func receive() async throws -> Data {
        do {
            switch try await task.receive() {
            case let .data(data): return data
            case .string: throw WebSocketChannelError.unexpectedTextFrame
            @unknown default: throw WebSocketChannelError.unexpectedTextFrame
            }
        } catch let error as WebSocketChannelError {
            throw error
        } catch {
            if task.closeCode != .invalid {
                throw WebSocketChannelError.closed(code: task.closeCode.rawValue)
            }
            throw error
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    public var receivedByteCount: Int64? { task.countOfBytesReceived }
}

public typealias WebSocketChannelFactory = @Sendable (URL) -> any WebSocketChannel

/// Relay controls are transport-only; Noise sees only unmodified binary frames.
enum RelayFrame: Sendable {
    case binary(Data)
    case text(String)
}

protocol RelaySocket: AnyObject, Sendable {
    func send(_ frame: RelayFrame) async throws
    func receive() async throws -> RelayFrame
    func close()
    var receivedByteCount: Int64? { get }
}

private final class URLSessionRelaySocket: RelaySocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(url: URL, token: String, session: URLSession = .shared) {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = remoteMaxMessageBytes + 64 * 1024
        task.resume()
    }

    func send(_ frame: RelayFrame) async throws {
        switch frame {
        case let .binary(data): try await task.send(.data(data))
        case let .text(text): try await task.send(.string(text))
        }
    }

    func receive() async throws -> RelayFrame {
        do {
            switch try await task.receive() {
            case let .data(data): return .binary(data)
            case let .string(text): return .text(text)
            @unknown default: throw WebSocketChannelError.unexpectedTextFrame
            }
        } catch {
            // URLSession errors may contain request details. Never propagate bearer credentials.
            if (task.response as? HTTPURLResponse)?.statusCode == 401 { throw WebSocketChannelError.relayUnauthorized }
            if task.closeCode != .invalid { throw WebSocketChannelError.closed(code: task.closeCode.rawValue) }
            throw URLError(.cannotConnectToHost)
        }
    }

    func close() { task.cancel(with: .normalClosure, reason: nil) }
    var receivedByteCount: Int64? { task.countOfBytesReceived }
}

/// A fresh session path identifies each dial, while the bearer credential stays in the header.
public final class RelayWebSocketChannel: WebSocketChannel, @unchecked Sendable {
    private let socket: any RelaySocket
    private let lock = NSLock()
    private var closed = false
    private var heartbeat: Task<Void, Never>?
    private let opened: Task<Void, Error>

    public convenience init(url: URL, token: String) {
        self.init(socket: URLSessionRelaySocket(url: url, token: token))
    }

    init(socket: any RelaySocket) {
        self.socket = socket
        opened = Task {
            let frame = try await socket.receive()
            guard case let .text(text) = frame, Self.controlType(text) == "open" else {
                throw WebSocketChannelError.unexpectedTextFrame
            }
        }
    }

    private static func controlType(_ text: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return nil }
        return object["type"] as? String
    }

    private func waitForOpen() async throws {
        do {
            try await opened.value
            try Task.checkCancellation()
            lock.withLock {
                guard !closed, heartbeat == nil else { return }
                heartbeat = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(30))
                        guard !Task.isCancelled, let self else { return }
                        do { try await self.socket.send(.text(#"{"type":"ping"}"#)) }
                        catch { self.close(); return }
                    }
                }
            }
            guard !lock.withLock({ closed }) else { throw WebSocketChannelError.closed(code: 1000) }
        } catch {
            close()
            throw error
        }
    }

    public func send(_ data: Data) async throws {
        try await waitForOpen()
        try await socket.send(.binary(data))
    }

    public func receive() async throws -> Data {
        try await waitForOpen()
        do {
            while true {
                switch try await socket.receive() {
                case let .binary(data): return data
                case let .text(text):
                    guard Self.controlType(text) == "pong" else { throw WebSocketChannelError.unexpectedTextFrame }
                }
            }
        } catch {
            close()
            throw error
        }
    }

    public func close() {
        let shouldClose = lock.withLock { () -> Bool in
            guard !closed else { return false }
            closed = true
            heartbeat?.cancel()
            return true
        }
        if shouldClose { socket.close() }
    }

    public var receivedByteCount: Int64? { socket.receivedByteCount }
}
