import Foundation

public enum AddressRecoveryOutcome: String, Equatable, Sendable {
    case checking, notConfigured, notFound, unchanged, updated, failed
}

public struct AddressRecoveryStatus: Equatable, Sendable {
    public let outcome: AddressRecoveryOutcome
    public let checkedAt: Date?
    public let detail: String?

    public init(outcome: AddressRecoveryOutcome, checkedAt: Date? = nil, detail: String? = nil) {
        self.outcome = outcome
        self.checkedAt = checkedAt
        self.detail = detail
    }
}

public enum ManualAddressError: Error, LocalizedError {
    case invalid
    public var errorDescription: String? {
        "Enter a host or ws/wss/http/https address, optionally ending in /remote/v1. Credentials, queries, fragments and pairing links are not allowed."
    }
}

public enum DesktopAddress {
    public static func normalize(_ input: String) throws -> String {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains(where: { $0.isWhitespace }), !value.contains("\\") else { throw ManualAddressError.invalid }
        let hasScheme = value.contains("://")
        if !hasScheme { value = "ws://" + value }
        guard var parts = URLComponents(string: value),
              let scheme = parts.scheme?.lowercased(), ["ws", "wss", "http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              ["", "/", "/remote/v1"].contains(parts.percentEncodedPath),
              parts.port.map({ (1...65535).contains($0) }) ?? true
        else { throw ManualAddressError.invalid }
        let ipv4Parts = host.split(separator: ".")
        let isIPAddress = host.contains(":") || (ipv4Parts.count == 4 && ipv4Parts.allSatisfy { UInt8($0) != nil })
        let isLocalName = !host.contains(".") || host.lowercased().hasSuffix(".local")
        parts.scheme = (scheme == "https" || scheme == "wss" || (!hasScheme && !isIPAddress && !isLocalName)) ? "wss" : "ws"
        parts.path = "/remote/v1"
        guard let url = parts.url else { throw ManualAddressError.invalid }
        return url.absoluteString
    }

    /// Replace the primary target, retaining only distinct explicitly LAN fallbacks.
    public static func replacingPrimary(in desktop: PairedDesktop, address: String, at date: Date = Date()) throws -> PairedDesktop {
        let url = try normalize(address)
        if desktop.endpoints.first?.url == url { return desktop }
        var updated = desktop
        updated.endpoints = [StoredEndpoint(kind: "manual", url: url)] + desktop.endpoints.dropFirst().filter { $0.kind == "lan" && $0.url != url }
        if updated.endpoints != desktop.endpoints {
            updated.lastAddressUpdateAt = date
            updated.lastAddressUpdateURL = url
        }
        return updated
    }
}
