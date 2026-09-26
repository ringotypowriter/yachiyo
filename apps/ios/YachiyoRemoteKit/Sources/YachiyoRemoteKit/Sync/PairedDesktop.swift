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

    public init(kind: String, url: String) {
        self.kind = kind
        self.url = url
    }

    init(_ endpoint: RemoteEndpoint) {
        self.init(kind: endpoint.kind.rawValue, url: endpoint.url)
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
