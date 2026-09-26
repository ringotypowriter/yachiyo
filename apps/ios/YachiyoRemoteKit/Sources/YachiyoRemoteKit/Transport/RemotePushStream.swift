import Foundation

/// Pushes from one connection, in receive order, for a single consumer.
///
/// Bounded with backpressure: when `capacity` pushes are waiting, the connection stops reading
/// the socket until the consumer takes one. Nothing is dropped, so the consumer must run from
/// the moment the client exists; RPC responses queued behind unconsumed pushes wait with them.
/// The desktop's send buffer bounds the other side. After the connection ends, pushes already
/// received are still delivered, then iteration finishes.
public final class RemotePushStream: AsyncSequence, @unchecked Sendable {
    public typealias Element = RemotePush

    private let capacity: Int
    private let lock = NSLock()
    private var buffer: [RemotePush] = []
    private var head = 0
    private var finished = false
    private var consumer: CheckedContinuation<RemotePush?, Never>?
    private var consumerToken: UUID?
    private var producer: CheckedContinuation<Void, Never>?

    init(capacity: Int) {
        precondition(capacity > 0)
        self.capacity = capacity
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        let stream: RemotePushStream
        public mutating func next() async -> RemotePush? { await stream.next() }
    }

    public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(stream: self) }

    private var count: Int { buffer.count - head }

    /// Suspends while the buffer is full. Returns false once the stream has finished.
    func enqueue(_ push: RemotePush, onPause: () -> Void = {}) async -> Bool {
        while true {
            enum Step { case delivered(CheckedContinuation<RemotePush?, Never>?), finished, full }
            let step: Step = lock.withLock {
                if finished { return .finished }
                if let consumer {
                    self.consumer = nil
                    consumerToken = nil
                    return .delivered(consumer)
                }
                if count < capacity {
                    buffer.append(push)
                    return .delivered(nil)
                }
                return .full
            }
            switch step {
            case let .delivered(consumer):
                consumer?.resume(returning: push)
                return true
            case .finished:
                return false
            case .full:
                onPause()
                await withCheckedContinuation { continuation in
                    let resumeNow = lock.withLock {
                        if finished || count < capacity { return true }
                        producer = continuation
                        return false
                    }
                    if resumeNow { continuation.resume() }
                }
            }
        }
    }

    /// Ends the stream; buffered pushes remain available to the consumer.
    func finish() {
        let (waitingConsumer, waitingProducer) = lock.withLock {
            finished = true
            defer {
                producer = nil
                if count == 0 {
                    consumer = nil
                    consumerToken = nil
                }
            }
            return (count == 0 ? consumer : nil, producer)
        }
        waitingConsumer?.resume(returning: nil)
        waitingProducer?.resume()
    }

    func next() async -> RemotePush? {
        let token = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<RemotePush?, Never>) in
                let (value, resumeProducer, isDone): (RemotePush?, CheckedContinuation<Void, Never>?, Bool) = lock.withLock {
                    if count > 0 {
                        let value = buffer[head]
                        head += 1
                        // Compact occasionally so dequeue stays O(1) amortized.
                        if head >= 64, head * 2 >= buffer.count {
                            buffer.removeFirst(head)
                            head = 0
                        }
                        defer { producer = nil }
                        return (value, producer, false)
                    }
                    if finished || Task.isCancelled { return (nil, nil, true) }
                    consumer = continuation
                    consumerToken = token
                    return (nil, nil, false)
                }
                resumeProducer?.resume()
                if value != nil || isDone { continuation.resume(returning: value) }
            }
        } onCancel: {
            let waiting = lock.withLock { () -> CheckedContinuation<RemotePush?, Never>? in
                guard consumerToken == token else { return nil }
                defer {
                    consumer = nil
                    consumerToken = nil
                }
                return consumer
            }
            waiting?.resume(returning: nil)
        }
    }
}
