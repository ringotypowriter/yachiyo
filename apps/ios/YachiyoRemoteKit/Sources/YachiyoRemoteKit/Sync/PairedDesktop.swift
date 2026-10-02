import Foundation

/// Where to pick up a desktop's event stream after a reconnect.
public struct ResumeCursor: Codable, Equatable, Sendable {
    public var epoch: String
    public var seq: Int

    public init(epoch: String, seq: Int) {
        self.epoch = epoch
        self.seq = seq
    }
}

public struct StoredEndpoint: Codable, Equatable, Sendable {
    public var kind: String
    public var url: String
    /// Relay phone bearer credential, stored with the pairing in the non-backed-up Keychain.
    public var token: String?

    public init(kind: String, url: String, token: String? = nil) {
        self.kind = kind
        self.url = url
        self.token = token
    }

    init(_ endpoint: RemoteEndpoint) {
        self.init(kind: endpoint.kind.rawValue, url: endpoint.url, token: endpoint.token)
    }

    /// A relay session URL is never persisted; a new UUID path is made for each dial.
    var dialURL: URL? {
        guard kind == "relay" else { return URL(string: url) }
        guard let token, token.count == 43, Base64URL.decode(token)?.count == 32,
              var components = URLComponents(string: url), components.scheme == "wss",
              components.host != nil, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.percentEncodedPath.hasPrefix("/v1/phones/"), components.percentEncodedPath.hasSuffix("/ws")
        else { return nil }
        components.percentEncodedPath.insert(contentsOf: UUID().uuidString.lowercased() + "/", at: components.percentEncodedPath.index(components.percentEncodedPath.endIndex, offsetBy: -2))
        return components.url
    }
}

/// Everything the phone keeps about one paired Mac. Stored in the Keychain; never backed up.
public struct PairedDesktop: Codable, Equatable, Sendable, Identifiable {
    public var id: String { remoteDeviceId }
    public var remoteDeviceId: String
    public var pairingId: String
    public var deviceName: String
    public var desktopKey: Data
    public var mailboxSecret: Data
    /// Highest mailbox counter accepted so far; older boxes are rejected.
    public var mailboxCounter: Int
    public var endpoints: [StoredEndpoint]
    public var syncDeviceId: String?
    /// Legacy: the event cursor now lives in the snapshot cache (`RemoteCache`). Kept decodable
    /// so a record written by an older build can seed a cache that has no cursor yet; new
    /// writes leave it nil.
    public var cursor: ResumeCursor?
    /// Dialed first on the next connect, across launches.
    public var lastSuccessfulURL: String?
    public var lastAddressUpdateAt: Date?
    public var lastAddressUpdateURL: String?

    public init(
        remoteDeviceId: String,
        pairingId: String,
        deviceName: String,
        desktopKey: Data,
        mailboxSecret: Data,
        mailboxCounter: Int = 0,
        endpoints: [StoredEndpoint],
        syncDeviceId: String? = nil,
        cursor: ResumeCursor? = nil
    ) {
        self.remoteDeviceId = remoteDeviceId
        self.pairingId = pairingId
        self.deviceName = deviceName
        self.desktopKey = desktopKey
        self.mailboxSecret = mailboxSecret
        self.mailboxCounter = mailboxCounter
        self.endpoints = endpoints
        self.syncDeviceId = syncDeviceId
        self.cursor = cursor
    }
}

extension PairedDesktop {
    /// Installs the desktop's current relay endpoints (one per region) ahead of the direct ones,
    /// as a mailbox update does. Returns false, changing nothing, when none can be dialed.
    @discardableResult
    public mutating func adoptRelayEndpoints(_ offered: [RemoteEndpoint]) -> Bool {
        let relay = offered.map(StoredEndpoint.init).filter { $0.kind == "relay" && $0.dialURL != nil }
        guard !relay.isEmpty else { return false }
        endpoints = relay + endpoints.filter { $0.kind != "relay" }
        return true
    }
}
