import CryptoKit
import Foundation

/// X25519 / ChaChaPoly / SHA-256 building blocks shared by the handshake, transport, and mailbox.
/// Matches apps/desktop/src/main/remote/noise/primitives.ts byte for byte.
enum NoisePrimitives {
    static let dhLength = 32
    static let hashLength = 32
    static let tagLength = 16

    static func publicKey(forPrivate privateKey: Data) throws -> Data {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey).publicKey.rawRepresentation
    }

    static func dh(privateKey: Data, publicKey: Data) throws -> Data {
        let local = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        let remote = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
        let shared = try local.sharedSecretFromKeyAgreement(with: remote)
        return shared.withUnsafeBytes { Data($0) }
    }

    /// Noise nonce: 32 zero bits followed by the little-endian 64-bit counter.
    static func nonce(counter: UInt64) -> Data {
        var data = Data(count: 4)
        withUnsafeBytes(of: counter.littleEndian) { data.append(contentsOf: $0) }
        return data
    }

    static func seal(key: Data, nonce: Data, ad: Data, plaintext: Data) throws -> Data {
        let box = try ChaChaPoly.seal(
            plaintext,
            using: SymmetricKey(data: key),
            nonce: ChaChaPoly.Nonce(data: nonce),
            authenticating: ad
        )
        return box.ciphertext + box.tag
    }

    static func open(key: Data, nonce: Data, ad: Data, ciphertext: Data) throws -> Data {
        guard ciphertext.count >= tagLength else { throw NoiseError.messageTooShort }
        let body = ciphertext.prefix(ciphertext.count - tagLength)
        let tag = ciphertext.suffix(tagLength)
        let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: body, tag: tag)
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
    }

    static func sha256(_ parts: Data...) -> Data {
        var hasher = SHA256()
        for part in parts { hasher.update(data: part) }
        return Data(hasher.finalize())
    }

    static func hmac(key: Data, _ parts: Data...) -> Data {
        var mac = HMAC<SHA256>(key: SymmetricKey(data: key))
        for part in parts { mac.update(data: part) }
        return Data(mac.finalize())
    }

    /// Noise HKDF (spec §4.3), not RFC 5869.
    static func noiseHKDF(chainingKey: Data, ikm: Data, outputs: Int) -> [Data] {
        let tempKey = hmac(key: chainingKey, ikm)
        let out1 = hmac(key: tempKey, Data([1]))
        let out2 = hmac(key: tempKey, out1, Data([2]))
        if outputs == 2 { return [out1, out2] }
        return [out1, out2, hmac(key: tempKey, out2, Data([3]))]
    }
}

public enum NoiseError: Error, Equatable {
    case messageTooShort
    case outOfOrder
    case handshakeIncomplete
    case missingPSK
    case nonceExhausted
    case channelClosed
    case messageTooLarge
}
