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
