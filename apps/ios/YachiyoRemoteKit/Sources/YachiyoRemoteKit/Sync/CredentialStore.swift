import Foundation
import Security

/// Phone keys and pairings. Production uses the Keychain with this-device-only accessibility,
/// so pairings never leave the phone through backups.
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

    public func save(_ desktop: PairedDesktop) throws {
        try lock.withLock {
            var desktops = try readDesktops().filter { $0.remoteDeviceId != desktop.remoteDeviceId }
            desktops.append(desktop)
            try write(JSONEncoder().encode(desktops), account: "desktops")
        }
    }

    public func remove(remoteDeviceId: String) throws {
        try lock.withLock {
            let desktops = try readDesktops().filter { $0.remoteDeviceId != remoteDeviceId }
            try write(JSONEncoder().encode(desktops), account: "desktops")
        }
    }

    private func readDesktops() throws -> [PairedDesktop] {
        guard let data = try read(account: "desktops") else { return [] }
        return try JSONDecoder().decode([PairedDesktop].self, from: data)
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
