import Foundation

/// Reads a desktop's address-recovery box. The app implements it over the iCloud Drive folder the
/// user picked once; tests use fixed data.
public enum MailboxReadError: Error { case notConfigured, accessDenied, staleBookmark, timedOut }

public protocol MailboxSource: Sendable {
    func read(mailboxId: String) async throws -> Data?
}

/// `Documents/Yachiyo` in iCloud Drive, reached through a security-scoped bookmark saved when the
/// user picked the folder. Reads download the file first and go through NSFileCoordinator,
/// except when the downloaded file is unchanged since the previous read.
public final class BookmarkedFolderMailboxSource: MailboxSource, @unchecked Sendable {
    public enum FolderError: Error { case wrongFolder }

    private let bookmark: Data
    private let readDeadline: TimeInterval

    public init(bookmark: Data, readDeadline: TimeInterval = 5) {
        self.bookmark = bookmark
        self.readDeadline = readDeadline
    }

    public static func makeBookmark(for folder: URL) throws -> Data {
        let accessing = folder.startAccessingSecurityScopedResource()
        defer { if accessing { folder.stopAccessingSecurityScopedResource() } }
        try validateFolder(folder)
        return try folder.bookmarkData(options: bookmarkCreationOptions, includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    /// Structural validation only; mailbox authentication still happens when recovering an address.
    /// Never create missing directories: an empty lookalike folder cannot receive the Mac's files.
    static func validateFolder(_ folder: URL) throws {
        guard folder.lastPathComponent == "Yachiyo",
              try folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true,
              try folder.appendingPathComponent("Remote").resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
        else { throw FolderError.wrongFolder }
    }

    /// Blocking file coordination runs on a dedicated queue, never on the cooperative pool, and
    /// the caller stops waiting after `readDeadline` (iCloud downloads can stall indefinitely).
    /// Reads share one serial queue, so a stalled read makes later ones time out too.
    public func read(mailboxId: String) async throws -> Data? {
        let bookmark = bookmark
        let box = ResumeOnce<Result<Data?, Error>>()
        return try await withTaskCancellationHandler {
            try await withCheckedContinuation { continuation in
                box.install(continuation)
                Self.queue.async { box.resume(Result { try Self.readNow(bookmark: bookmark, mailboxId: mailboxId) }) }
                Self.deadlineQueue.asyncAfter(deadline: .now() + readDeadline) { box.resume(.failure(MailboxReadError.timedOut)) }
            }.get()
        } onCancel: {
            box.resume(.failure(CancellationError()))
        }
    }

    private static let queue = DispatchQueue(label: "sh.ringo.yachiyo.remote.mailbox", qos: .utility)
    private static let deadlineQueue = DispatchQueue(label: "sh.ringo.yachiyo.remote.mailbox-deadline", qos: .utility)
    /// The last box read per file, keyed by path, with the modification date it had. Sources
    /// are created per read, so this lives for the process.
    private static let lastRead = LastReadCache()

    private final class LastReadCache: @unchecked Sendable {
        let lock = NSLock()
        var entries: [String: (modified: Date, data: Data)] = [:]
    }

    private static func readNow(bookmark: Data, mailboxId: String) throws -> Data? {
        var stale = false
        let folder = try URL(resolvingBookmarkData: bookmark, options: Self.bookmarkResolutionOptions, relativeTo: nil, bookmarkDataIsStale: &stale)
        guard !stale else { throw MailboxReadError.staleBookmark }
        let accessing = folder.startAccessingSecurityScopedResource()
        defer { if accessing { folder.stopAccessingSecurityScopedResource() } }
        let file = folder.appendingPathComponent("Remote").appendingPathComponent("\(mailboxId).box")
        // An unchanged, fully downloaded file holds the box already read, whose counter was
        // accepted or rejected then; skip coordination and IO for it.
        let modified = unchangedModificationDate(of: file)
        if let modified, let cached = lastRead.lock.withLock({ lastRead.entries[file.path] }), cached.modified == modified {
            return cached.data
        }
        try? FileManager.default.startDownloadingUbiquitousItem(at: file)
        var coordinationError: NSError?
        var result: Data?
        var readError: Error?
        NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &coordinationError) { url in
            do { result = try Data(contentsOf: url) } catch { readError = error }
        }
        if let error = coordinationError ?? readError as NSError? {
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError { throw MailboxReadError.accessDenied }
            throw error
        }
        // Keyed by the date seen before reading: a write during the read changes the date again,
        // so it can never pin older bytes to a newer date.
        if let result, let modified {
            lastRead.lock.withLock { lastRead.entries[file.path] = (modified, result) }
        }
        return result
    }

    /// The local copy's modification date, only when it is known to be the current version.
    private static func unchangedModificationDate(of file: URL) -> Date? {
        guard let values = try? file.resourceValues(forKeys: [.contentModificationDateKey, .ubiquitousItemDownloadingStatusKey]),
              let modified = values.contentModificationDate else { return nil }
        if let status = values.ubiquitousItemDownloadingStatus, status != .current { return nil }
        return modified
    }

    #if os(macOS)
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = [.withSecurityScope]
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
    #else
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = []
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = []
    #endif
}
