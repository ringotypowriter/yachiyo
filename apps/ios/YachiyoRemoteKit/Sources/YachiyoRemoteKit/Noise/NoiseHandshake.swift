import CryptoKit
import Foundation

public enum NoisePattern: Sendable {
    /// Reconnect of an existing pairing.
    case ik
    /// First pairing; the PSK is the one-time token from the QR code.
    case ikpsk2

    var protocolName: String {
        switch self {
        case .ik: "Noise_IK_25519_ChaChaPoly_SHA256"
        case .ikpsk2: "Noise_IKpsk2_25519_ChaChaPoly_SHA256"
        }
    }
}

/// Noise CipherState; the counter only advances after a successful encrypt or decrypt.
public final class NoiseCipherState: @unchecked Sendable {
    private let key: Data?
    private(set) var counter: UInt64 = 0

    init(key: Data?) {
        self.key = key
    }

    var hasKey: Bool { key != nil }

    func encrypt(ad: Data, plaintext: Data) throws -> Data {
        guard let key else { return plaintext }
        guard counter < UInt64.max else { throw NoiseError.nonceExhausted }
        let result = try NoisePrimitives.seal(key: key, nonce: NoisePrimitives.nonce(counter: counter), ad: ad, plaintext: plaintext)
        counter += 1
        return result
    }

    func decrypt(ad: Data, ciphertext: Data) throws -> Data {
        guard let key else { return ciphertext }
        guard counter < UInt64.max else { throw NoiseError.nonceExhausted }
        let result = try NoisePrimitives.open(key: key, nonce: NoisePrimitives.nonce(counter: counter), ad: ad, ciphertext: ciphertext)
        counter += 1
        return result
    }
}

/// The phone side (initiator) of `Noise_IK` and `Noise_IKpsk2`:
///   <- s
///   -> e, es, s, ss
///   <- e, ee, se [, psk]
public final class NoiseInitiator {
    private let pattern: NoisePattern
    private let staticPrivate: Data
    private let staticPublic: Data
    private let remoteStatic: Data
    private let psk: Data?
    private var ephemeralPrivate: Data
    private var remoteEphemeral: Data?
    private var chainingKey: Data
    private(set) var hash: Data
    private var cipher = NoiseCipherState(key: nil)
    private var step = 0

    public init(
        pattern: NoisePattern,
        prologue: Data,
        staticPrivateKey: Data,
        remoteStaticKey: Data,
        psk: Data? = nil,
        ephemeralPrivateKey: Data? = nil
    ) throws {
        if pattern == .ikpsk2, psk?.count != 32 { throw NoiseError.missingPSK }
        self.pattern = pattern
        staticPrivate = staticPrivateKey
        staticPublic = try NoisePrimitives.publicKey(forPrivate: staticPrivateKey)
        remoteStatic = remoteStaticKey
        self.psk = psk
        ephemeralPrivate = ephemeralPrivateKey ?? NoiseKeyPair.generatePrivateKey()
        let name = Data(pattern.protocolName.utf8)
        hash = name.count <= NoisePrimitives.hashLength
            ? name + Data(count: NoisePrimitives.hashLength - name.count)
            : NoisePrimitives.sha256(name)
        chainingKey = hash
        mixHash(prologue)
        mixHash(remoteStaticKey)
    }

    public var handshakeHash: Data { hash }

    public func writeMessage1(payload: Data) throws -> Data {
        guard step == 0 else { throw NoiseError.outOfOrder }
        var message = Data()
        let ephemeralPublic = try NoisePrimitives.publicKey(forPrivate: ephemeralPrivate)
        message.append(ephemeralPublic)
        mixHash(ephemeralPublic)
        if pattern == .ikpsk2 { mixKey(ephemeralPublic) }
        mixKey(try NoisePrimitives.dh(privateKey: ephemeralPrivate, publicKey: remoteStatic))
        message.append(try encryptAndHash(staticPublic))
        mixKey(try NoisePrimitives.dh(privateKey: staticPrivate, publicKey: remoteStatic))
        message.append(try encryptAndHash(payload))
        step = 1
        return message
    }

    public func readMessage2(_ message: Data) throws -> Data {
        guard step == 1 else { throw NoiseError.outOfOrder }
        guard message.count >= NoisePrimitives.dhLength else { throw NoiseError.messageTooShort }
        let bytes = Data(message)
        let remoteEphemeral = bytes.prefix(NoisePrimitives.dhLength)
        self.remoteEphemeral = remoteEphemeral
        mixHash(remoteEphemeral)
        if pattern == .ikpsk2 { mixKey(remoteEphemeral) }
        mixKey(try NoisePrimitives.dh(privateKey: ephemeralPrivate, publicKey: remoteEphemeral))
        mixKey(try NoisePrimitives.dh(privateKey: staticPrivate, publicKey: remoteEphemeral))
        if pattern == .ikpsk2 {
            guard let psk else { throw NoiseError.missingPSK }
            mixKeyAndHash(psk)
        }
        let payload = try decryptAndHash(bytes.suffix(from: bytes.startIndex + NoisePrimitives.dhLength))
        step = 2
        return payload
    }

    /// Transport ciphers oriented for the phone: send is initiator→responder.
    public func split() throws -> NoiseTransport {
        guard step == 2 else { throw NoiseError.handshakeIncomplete }
        let keys = NoisePrimitives.noiseHKDF(chainingKey: chainingKey, ikm: Data(), outputs: 2)
        return NoiseTransport(
            send: NoiseCipherState(key: keys[0].prefix(32)),
            receive: NoiseCipherState(key: keys[1].prefix(32)),
            handshakeHash: hash
        )
    }

    private func mixHash(_ data: Data) {
        hash = NoisePrimitives.sha256(hash, data)
    }

    private func mixKey(_ ikm: Data) {
        let outputs = NoisePrimitives.noiseHKDF(chainingKey: chainingKey, ikm: ikm, outputs: 2)
        chainingKey = outputs[0]
        cipher = NoiseCipherState(key: outputs[1].prefix(32))
    }

    private func mixKeyAndHash(_ ikm: Data) {
        let outputs = NoisePrimitives.noiseHKDF(chainingKey: chainingKey, ikm: ikm, outputs: 3)
        chainingKey = outputs[0]
        mixHash(outputs[1])
        cipher = NoiseCipherState(key: outputs[2].prefix(32))
    }

    private func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(ad: hash, plaintext: plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    private func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ad: hash, ciphertext: Data(ciphertext))
        mixHash(Data(ciphertext))
        return plaintext
    }
}

public enum NoiseKeyPair {
    public static func generatePrivateKey() -> Data {
        Curve25519.KeyAgreement.PrivateKey().rawRepresentation
    }

    public static func publicKey(forPrivate privateKey: Data) throws -> Data {
        try NoisePrimitives.publicKey(forPrivate: privateKey)
    }
}
