import CryptoKit
import Foundation

public struct RemoteCachedThread: Codable, Sendable {
    public var detail: RemoteThreadDetail
    public var needsRefresh: Bool

    public init(detail: RemoteThreadDetail, needsRefresh: Bool = true) {
        self.detail = detail
        self.needsRefresh = needsRefresh
    }
}

/// A cursor and the data it describes must always be persisted together.
public struct RemoteDesktopCache: Codable, Sendable {
    public var pairingId: String
    public var cursor: ResumeCursor?
    /// nil means the inbox has never loaded; an empty array means it loaded empty.
    public var summaries: [RemoteThreadSummary]?
    public var needsInboxRefresh: Bool
    /// The caller bounds this collection (normally to the last 20 snapshots).
    public var threads: [String: RemoteCachedThread]

    public init(
        pairingId: String,
        cursor: ResumeCursor? = nil,
        summaries: [RemoteThreadSummary]? = nil,
        needsInboxRefresh: Bool = true,
        threads: [String: RemoteCachedThread] = [:]
    ) {
        self.pairingId = pairingId
        self.cursor = cursor
        self.summaries = summaries
        self.needsInboxRefresh = needsInboxRefresh
        self.threads = threads
    }
}

/// Synchronous disk cache. Callers must serialize access off the main thread and
/// supply a dedicated directory beneath the application's caches directory.
public struct RemoteCacheStore: Sendable {
    private let directory: URL

    private struct Envelope: Codable {
        let version: Int
        let cache: RemoteDesktopCache
    }

    public init(directory: URL) {
        self.directory = directory
    }

    /// Missing, unreadable, incompatible and unpaired snapshots are cache misses.
    public func load(desktopId: String, pairingId: String) -> RemoteDesktopCache? {
        guard let data = try? Data(contentsOf: fileURL(desktopId: desktopId)),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.version == 1,
              envelope.cache.pairingId == pairingId else { return nil }
        return envelope.cache
    }

    public func save(_ cache: RemoteDesktopCache, desktopId: String) throws {
        let data = try JSONEncoder().encode(Envelope(version: 1, cache: cache))
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try manager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        #endif
        try excludeFromBackup(directory)

        let url = fileURL(desktopId: desktopId)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try excludeFromBackup(url)
    }

    /// Removing an already absent snapshot is harmless.
    public func remove(desktopId: String) throws {
        do {
            try FileManager.default.removeItem(at: fileURL(desktopId: desktopId))
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && error.code == NSFileNoSuchFileError {
            return
        }
    }

    private func fileURL(desktopId: String) -> URL {
        let digest = SHA256.hash(data: Data(desktopId.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".json", isDirectory: false)
    }

    private func excludeFromBackup(_ url: URL) throws {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
}
