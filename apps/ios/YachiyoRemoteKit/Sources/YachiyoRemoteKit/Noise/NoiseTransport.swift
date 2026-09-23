import Foundation

/// Decrypted WebSocket message cap; mirrors REMOTE_MAX_MESSAGE_BYTES on the desktop.
public let remoteMaxMessageBytes = 8 * 1024 * 1024

/// One AEAD message per WebSocket frame with implicit counter nonces. Any authentication
/// failure closes the channel for good: replayed, dropped, or reordered frames cannot pass.
public final class NoiseTransport: @unchecked Sendable {
    private let send: NoiseCipherState
    private let receive: NoiseCipherState
    private let lock = NSLock()
    private var failed = false
    public let handshakeHash: Data

    init(send: NoiseCipherState, receive: NoiseCipherState, handshakeHash: Data) {
        self.send = send
        self.receive = receive
        self.handshakeHash = handshakeHash
    }

    public func encrypt(_ plaintext: Data) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        guard !failed else { throw NoiseError.channelClosed }
        guard plaintext.count <= remoteMaxMessageBytes else { throw NoiseError.messageTooLarge }
        return try send.encrypt(ad: Data(), plaintext: plaintext)
    }

    public func decrypt(_ ciphertext: Data) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        guard !failed else { throw NoiseError.channelClosed }
        do {
            guard ciphertext.count <= remoteMaxMessageBytes + NoisePrimitives.tagLength else {
                throw NoiseError.messageTooLarge
            }
            return try receive.decrypt(ad: Data(), ciphertext: ciphertext)
        } catch {
            failed = true
            throw error
        }
    }
}
