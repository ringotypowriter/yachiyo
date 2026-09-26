import Foundation
import Security

/// Phone keys and pairings. Production uses the Keychain with this-device-only accessibility,
/// so pairings never leave the phone through backups.
///
/// Implementations are thread-safe: every method may be called from any thread, and calls are
/// serialized internally. Keychain calls block, so callers should stay off the main thread.
/// Callers that write from several threads own the order of their writes (use one queue).
public protocol RemoteCredentialStore: AnyObject, Sendable {
    /// The phone's X25519 static private key, created on first use.
    func phoneStaticKey() throws -> Data
    func loadDesktops() throws -> [PairedDesktop]
    func save(_ desktop: PairedDesktop) throws
    func remove(remoteDeviceId: String) throws
}

public final class InMemoryCredentialStore: RemoteCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var key: Data?
    private var desktops: [String: PairedDesktop] = [:]

    public init() {}

    public func phoneStaticKey() throws -> Data {
        lock.withLock {
            if let key { return key }
            let created = NoiseKeyPair.generatePrivateKey()
            key = created
            return created
        }
    }

    public func loadDesktops() throws -> [PairedDesktop] {
        lock.withLock { desktops.values.sorted { $0.deviceName < $1.deviceName } }
    }

    public func save(_ desktop: PairedDesktop) throws {
        lock.withLock { desktops[desktop.remoteDeviceId] = desktop }
    }

    public func remove(remoteDeviceId: String) throws {
        lock.withLock { _ = desktops.removeValue(forKey: remoteDeviceId) }
    }
}

public enum KeychainError: Error, Equatable {
    case status(OSStatus)
}

public final class KeychainCredentialStore: RemoteCredentialStore, @unchecked Sendable {
    private let service: String
    private let lock = NSLock()
    /// The decoded `desktops` item after the first read or write; this process is its only
    /// writer, so saves need not read the Keychain back first.
    private var desktopsCache: [PairedDesktop]?

    public init(service: String = "sh.ringo.yachiyo.remote") {
        self.service = service
    }

    public func phoneStaticKey() throws -> Data {
        try lock.withLock {
            if let existing = try read(account: "phone-static-key") { return existing }
            let created = NoiseKeyPair.generatePrivateKey()
            try write(created, account: "phone-static-key")
            return created
        }
    }

    public func loadDesktops() throws -> [PairedDesktop] {
        try lock.withLock { try readDesktops() }
    }

    /// No Keychain write when the stored record is already identical.
    public func save(_ desktop: PairedDesktop) throws {
        try lock.withLock {
            let existing = try readDesktops()
            if existing.contains(desktop) { return }
            try writeDesktops(existing.filter { $0.remoteDeviceId != desktop.remoteDeviceId } + [desktop])
        }
    }

    public func remove(remoteDeviceId: String) throws {
        try lock.withLock {
            try writeDesktops(try readDesktops().filter { $0.remoteDeviceId != remoteDeviceId })
        }
    }

    private func readDesktops() throws -> [PairedDesktop] {
        if let desktopsCache { return desktopsCache }
        let desktops = try read(account: "desktops").map { try JSONDecoder().decode([PairedDesktop].self, from: $0) } ?? []
        desktopsCache = desktops
        return desktops
    }

    private func writeDesktops(_ desktops: [PairedDesktop]) throws {
        try write(JSONEncoder().encode(desktops), account: "desktops")
        desktopsCache = desktops
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    private func read(account: String) throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        return result as? Data
    }

    private func write(_ data: Data, account: String) throws {
        let query = baseQuery(account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }
}
