import CryptoKit
import Foundation

public enum MailboxError: Error, Equatable {
    case unsupportedFormat
    case rolledBack
    case invalidSecret
}

/// Address recovery box written by the desktop to iCloud Drive (see mailboxCrypto.ts):
/// `0x01 || nonce(12) || ChaCha20-Poly1305(key, nonce, ad = 0x01, JSON plaintext)`.
public enum Mailbox {
    static let version: UInt8 = 0x01
    static let nonceLength = 12

    public struct Keys: Equatable, Sendable {
        /// File name (without `.box`) under `Documents/Yachiyo/Remote/`.
        public let mailboxId: String
        public let mailboxKey: Data
    }

    /// RFC 5869 HKDF-SHA256 with an empty salt, as on the desktop.
    public static func deriveKeys(secret: Data) throws -> Keys {
        guard secret.count == 32 else { throw MailboxError.invalidSecret }
        let input = SymmetricKey(data: secret)
        func derive(_ info: String) -> Data {
            HKDF<SHA256>.deriveKey(
                inputKeyMaterial: input,
                salt: Data(),
                info: Data(info.utf8),
                outputByteCount: 32
            ).withUnsafeBytes { Data($0) }
        }
        let id = derive("yachiyo-remote/v1/mailbox-id").prefix(16)
        return Keys(
            mailboxId: id.map { String(format: "%02x", $0) }.joined(),
            mailboxKey: derive("yachiyo-remote/v1/mailbox-key")
        )
    }

    /// Decrypts a box and rejects any counter not newer than `lastCounter`, so an old iCloud copy
    /// cannot move the phone back to a stale address.
    public static func open(box: Data, key: Data, lastCounter: Int) throws -> RemoteMailboxPlaintext {
        let bytes = Data(box)
        guard bytes.count > 1 + nonceLength, bytes[0] == version else {
            throw MailboxError.unsupportedFormat
        }
        let header = bytes.prefix(1)
        let nonce = bytes.subdata(in: 1 ..< 1 + nonceLength)
        let plaintext = try NoisePrimitives.open(
            key: key,
            nonce: nonce,
            ad: header,
            ciphertext: bytes.subdata(in: 1 + nonceLength ..< bytes.count)
        )
        let decoded = try JSONDecoder().decode(RemoteMailboxPlaintext.self, from: plaintext)
        guard decoded.counter > lastCounter else { throw MailboxError.rolledBack }
        return decoded
    }
}
