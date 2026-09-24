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

/// Local copies of images sent from this phone. Remote image ids are indices within a
/// message; scope files by desktop and thread so deleting either removes its previews.
public struct RemoteSentImageStore: Sendable {
    private let directory: URL
    private struct PendingImage: Codable {
        let runId: String
        let data: Data
    }

    public init(directory: URL) { self.directory = directory }

    public func save(_ data: Data, desktopId: String, threadId: String, messageId: String, imageId: String) throws {
        guard !data.isEmpty else { return }
        try writeProtected(data, to: fileURL(desktopId: desktopId, threadId: threadId, messageId: messageId, imageId: imageId))
    }

    public func load(desktopId: String, threadId: String, messageId: String, imageId: String) -> Data? {
        try? Data(contentsOf: fileURL(desktopId: desktopId, threadId: threadId, messageId: messageId, imageId: imageId))
    }

    /// A steer has no message ID in its acknowledgement. Its composer UUID filename is
    /// preserved by the server until the user message materializes.
    public func savePending(_ data: Data, desktopId: String, threadId: String, filename: String, runId: String) throws {
        guard !data.isEmpty else { return }
        try writeProtected(JSONEncoder().encode(PendingImage(runId: runId, data: data)),
                           to: pendingURL(desktopId: desktopId, threadId: threadId, filename: filename))
    }

    private func writeProtected(_ data: Data, to url: URL) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var excludedFolder = folder
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excludedFolder.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: folder.path)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }

    public func loadPending(desktopId: String, threadId: String, filename: String) -> (runId: String, data: Data)? {
        let url = pendingURL(desktopId: desktopId, threadId: threadId, filename: filename)
        guard let data = try? Data(contentsOf: url), let pending = try? JSONDecoder().decode(PendingImage.self, from: data) else { return nil }
        return (pending.runId, pending.data)
    }

    public func removePending(desktopId: String, threadId: String, filename: String) throws {
        let url = pendingURL(desktopId: desktopId, threadId: threadId, filename: filename)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    public func removePending(desktopId: String, threadId: String) throws {
        let folder = pendingDirectory(desktopId: desktopId, threadId: threadId)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

    public func remove(desktopId: String, threadId: String) throws {
        let folder = threadDirectory(desktopId: desktopId, threadId: threadId)
        if FileManager.default.fileExists(atPath: folder.path) {
            try FileManager.default.removeItem(at: folder)
        }
    }

    public func remove(desktopId: String) throws {
        let folder = desktopDirectory(desktopId)
        if FileManager.default.fileExists(atPath: folder.path) {
            try FileManager.default.removeItem(at: folder)
        }
    }

    private func desktopDirectory(_ desktopId: String) -> URL {
        directory.appendingPathComponent(digest(desktopId), isDirectory: true)
    }

    private func threadDirectory(desktopId: String, threadId: String) -> URL {
        desktopDirectory(desktopId).appendingPathComponent(digest(threadId), isDirectory: true)
    }

    private func fileURL(desktopId: String, threadId: String, messageId: String, imageId: String) -> URL {
        // Hash untrusted remote identifiers instead of interpreting them as path components.
        threadDirectory(desktopId: desktopId, threadId: threadId)
            .appendingPathComponent(digest("\(messageId)/\(imageId)"), isDirectory: false)
    }

    private func pendingDirectory(desktopId: String, threadId: String) -> URL {
        threadDirectory(desktopId: desktopId, threadId: threadId).appendingPathComponent("pending", isDirectory: true)
    }

    private func pendingURL(desktopId: String, threadId: String, filename: String) -> URL {
        pendingDirectory(desktopId: desktopId, threadId: threadId).appendingPathComponent(digest(filename), isDirectory: false)
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
