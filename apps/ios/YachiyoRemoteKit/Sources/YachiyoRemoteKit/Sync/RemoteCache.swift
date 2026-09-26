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

/// Launch-time state of one Mac: everything except thread histories, which load on demand.
public struct RemoteDesktopCache: Sendable, Equatable {
    public var pairingId: String
    public var cursor: ResumeCursor?
    /// nil means the inbox has never loaded; an empty array means it loaded empty.
    public var summaries: [RemoteThreadSummary]?
    public var needsInboxRefresh: Bool
    /// Thread histories stored on disk, most recently used first. The caller bounds this list
    /// (normally to 20) and removes evicted histories in the same save.
    public var threadIds: [String]
    /// Histories that must be refetched regardless of the flag in their own file. Kept with the
    /// cursor, so an invalidation is never persisted later than the cursor that passed it, and
    /// marking a history stale does not rewrite it.
    public var staleThreadIds: Set<String>

    public init(
        pairingId: String,
        cursor: ResumeCursor? = nil,
        summaries: [RemoteThreadSummary]? = nil,
        needsInboxRefresh: Bool = true,
        threadIds: [String] = [],
        staleThreadIds: Set<String> = []
    ) {
        self.pairingId = pairingId
        self.cursor = cursor
        self.summaries = summaries
        self.needsInboxRefresh = needsInboxRefresh
        self.threadIds = threadIds
        self.staleThreadIds = staleThreadIds
    }
}

/// Synchronous disk cache. Callers must serialize access off the main thread and
/// supply a dedicated directory beneath the application's caches directory.
///
/// Each Mac has its own folder so a stream of events does not rewrite everything:
/// - `state.json`: cursor, refresh flags and the thread index. Tiny; written on every save.
/// - `summaries.json`: the inbox, written only when the caller reports it changed.
/// - `threads/<hash>.json`: one history per thread, written only when that thread changed.
///
/// Invariant: a saved cursor may lag the saved data but is never ahead of it. `save` writes
/// data files first and `state.json` last, and never writes `state.json` while a changed data
/// file could be left stale on disk. Replaying from an older cursor over newer data converges,
/// because summaries and thread snapshots are full replacements and applied pushes are idempotent;
/// a cursor past the data would silently drop the events in between.
public struct RemoteCacheStore: Sendable {
    private static let version = 2
    private let directory: URL

    private struct StateFile: Codable {
        let version: Int
        let pairingId: String
        let cursor: ResumeCursor?
        let needsInboxRefresh: Bool
        let threadIds: [String]
        let staleThreadIds: [String]
    }

    private struct SummariesFile: Codable {
        let version: Int
        let pairingId: String
        let summaries: [RemoteThreadSummary]
    }

    private struct ThreadFile: Codable {
        let version: Int
        let pairingId: String
        let threadId: String
        let thread: RemoteCachedThread
    }

    /// The single-file format written before histories were split out (version 1).
    private struct LegacyEnvelope: Decodable {
        struct Cache: Decodable {
            let pairingId: String
            let cursor: ResumeCursor?
            let summaries: [RemoteThreadSummary]?
            let needsInboxRefresh: Bool
            let threads: [String: RemoteCachedThread]
        }
        let version: Int
        let cache: Cache
    }

    public init(directory: URL) {
        self.directory = directory
    }

    /// Loads cursor, flags and summaries, not thread histories. Missing, unreadable,
    /// incompatible and unpaired snapshots are cache misses. A single-file cache from an older
    /// build is migrated to the split layout on first load.
    public func load(desktopId: String, pairingId: String) -> RemoteDesktopCache? {
        let legacy = legacyURL(desktopId: desktopId)
        if !FileManager.default.fileExists(atPath: stateURL(desktopId).path),
           FileManager.default.fileExists(atPath: legacy.path) {
            return migrateLegacy(desktopId: desktopId, pairingId: pairingId)
        }
        try? FileManager.default.removeItem(at: legacy)
        guard let state = decode(StateFile.self, at: stateURL(desktopId)),
              state.version == Self.version, state.pairingId == pairingId else { return nil }
        var summaries: [RemoteThreadSummary]?
        if let file = decode(SummariesFile.self, at: summariesURL(desktopId)),
           file.version == Self.version, file.pairingId == pairingId {
            summaries = file.summaries
        }
        return RemoteDesktopCache(
            pairingId: pairingId, cursor: state.cursor, summaries: summaries,
            needsInboxRefresh: state.needsInboxRefresh, threadIds: state.threadIds,
            staleThreadIds: Set(state.staleThreadIds)
        )
    }

    public func loadThread(desktopId: String, pairingId: String, threadId: String) -> RemoteCachedThread? {
        guard let file = decode(ThreadFile.self, at: threadURL(desktopId: desktopId, threadId: threadId)),
              file.version == Self.version, file.pairingId == pairingId, file.threadId == threadId
        else { return nil }
        return file.thread
    }

    /// Writes the given thread histories, removes `removedThreadIds`, writes `cache.summaries`
    /// only when `summariesChanged`, and then records the cursor and index.
    public func save(
        _ cache: RemoteDesktopCache,
        desktopId: String,
        summariesChanged: Bool,
        threads: [String: RemoteCachedThread] = [:],
        removedThreadIds: Set<String> = []
    ) throws {
        try prepare(directory)
        try prepare(desktopDirectory(desktopId))
        var firstError: Error?
        // A data file that cannot be written must not survive stale behind a newer cursor.
        // Removing it turns it into a cache miss; if even that fails, keep the old cursor.
        func replace(_ url: URL, write: () throws -> Void) throws {
            do { try write() } catch {
                firstError = firstError ?? error
                try removeIfPresent(url)
            }
        }
        if !threads.isEmpty { try prepare(threadsDirectory(desktopId)) }
        for (threadId, thread) in threads {
            let url = threadURL(desktopId: desktopId, threadId: threadId)
            try replace(url) {
                try write(ThreadFile(version: Self.version, pairingId: cache.pairingId, threadId: threadId, thread: thread), to: url)
            }
        }
        for threadId in removedThreadIds where threads[threadId] == nil {
            try removeIfPresent(threadURL(desktopId: desktopId, threadId: threadId))
        }
        if summariesChanged {
            let url = summariesURL(desktopId)
            if let summaries = cache.summaries {
                try replace(url) {
                    try write(SummariesFile(version: Self.version, pairingId: cache.pairingId, summaries: summaries), to: url)
                }
            } else {
                try removeIfPresent(url)
            }
        }
        try write(StateFile(
            version: Self.version, pairingId: cache.pairingId, cursor: cache.cursor,
            needsInboxRefresh: cache.needsInboxRefresh, threadIds: cache.threadIds,
            staleThreadIds: cache.staleThreadIds.sorted()
        ), to: stateURL(desktopId))
        if let firstError { throw firstError }
    }

    /// Removing an already absent snapshot is harmless.
    public func remove(desktopId: String) throws {
        try removeIfPresent(desktopDirectory(desktopId))
        try removeIfPresent(legacyURL(desktopId: desktopId))
    }

    // MARK: Private

    private func migrateLegacy(desktopId: String, pairingId: String) -> RemoteDesktopCache? {
        let legacy = legacyURL(desktopId: desktopId)
        guard let envelope = decode(LegacyEnvelope.self, at: legacy), envelope.version == 1,
              envelope.cache.pairingId == pairingId else {
            try? FileManager.default.removeItem(at: legacy)
            return nil
        }
        let old = envelope.cache
        let cache = RemoteDesktopCache(
            pairingId: pairingId, cursor: old.cursor, summaries: old.summaries,
            needsInboxRefresh: old.needsInboxRefresh, threadIds: Array(old.threads.keys)
        )
        do {
            try save(cache, desktopId: desktopId, summariesChanged: true, threads: old.threads)
            try FileManager.default.removeItem(at: legacy)
            return cache
        } catch {
            // Keep the inbox for this launch; the histories are only a cache.
            try? remove(desktopId: desktopId)
            var inboxOnly = cache
            inboxOnly.threadIds = []
            return inboxOnly
        }
    }

    private func decode<Value: Decodable>(_ type: Value.Type, at url: URL) -> Value? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func write(_ value: some Encodable, to url: URL) throws {
        let data = try JSONEncoder().encode(value)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }

    /// Protection and backup exclusion are set once, when a folder is created; files inherit
    /// the exclusion from their folder.
    private func prepare(_ folder: URL) throws {
        let manager = FileManager.default
        guard !manager.fileExists(atPath: folder.path) else { return }
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        #if os(iOS)
        try manager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: folder.path
        )
        #endif
        var url = folder
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func removeIfPresent(_ url: URL) throws {
        do {
            try FileManager.default.removeItem(at: url)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && error.code == NSFileNoSuchFileError {
            return
        }
    }

    private func desktopDirectory(_ desktopId: String) -> URL {
        directory.appendingPathComponent(digest(desktopId), isDirectory: true)
    }

    private func threadsDirectory(_ desktopId: String) -> URL {
        desktopDirectory(desktopId).appendingPathComponent("threads", isDirectory: true)
    }

    private func stateURL(_ desktopId: String) -> URL {
        desktopDirectory(desktopId).appendingPathComponent("state.json", isDirectory: false)
    }

    private func summariesURL(_ desktopId: String) -> URL {
        desktopDirectory(desktopId).appendingPathComponent("summaries.json", isDirectory: false)
    }

    private func threadURL(desktopId: String, threadId: String) -> URL {
        // Hash untrusted remote identifiers instead of interpreting them as path components.
        threadsDirectory(desktopId).appendingPathComponent(digest(threadId) + ".json", isDirectory: false)
    }

    private func legacyURL(desktopId: String) -> URL {
        directory.appendingPathComponent(digest(desktopId) + ".json", isDirectory: false)
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
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
