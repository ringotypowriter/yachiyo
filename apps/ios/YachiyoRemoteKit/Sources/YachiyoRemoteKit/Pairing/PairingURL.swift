import Foundation

public enum PairingURLError: Error, Equatable {
    case notAPairingURL
    case unsupportedVersion
    case missingPayload
    case malformedPayload
    case expired
}

/// `yachiyo-remote://pair?v=1&d=<base64url(JSON RemotePairingPayload)>` from the desktop QR code.
public enum PairingURL {
    public static let scheme = "yachiyo-remote"

    public static func decode(_ url: URL, now: Date = Date()) throws -> RemotePairingPayload {
        guard url.scheme == scheme, url.host == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { throw PairingURLError.notAPairingURL }
        let items = components.queryItems ?? []
        guard items.first(where: { $0.name == "v" })?.value == String(remoteProtocolVersion) else {
            throw PairingURLError.unsupportedVersion
        }
        guard let encoded = items.first(where: { $0.name == "d" })?.value,
              let data = Base64URL.decode(encoded)
        else { throw PairingURLError.missingPayload }
        let payload: RemotePairingPayload
        do {
            payload = try JSONDecoder().decode(RemotePairingPayload.self, from: data)
        } catch {
            throw PairingURLError.malformedPayload
        }
        guard Base64URL.decode(payload.desktopKey)?.count == 32,
              Base64URL.decode(payload.token)?.count == 32,
              !payload.endpoints.isEmpty
        else { throw PairingURLError.malformedPayload }
        if let expiresAt = ISO8601.parse(payload.expiresAt), expiresAt <= now {
            throw PairingURLError.expired
        }
        return payload
    }
}

public enum Base64URL {
    public static func decode(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: base64)
    }

    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

public enum ISO8601 {
    public static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }
}
