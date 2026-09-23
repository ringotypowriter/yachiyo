import Foundation

/// Reads a desktop's address-recovery box. The app implements it over the iCloud Drive folder the
/// user picked once; tests use fixed data.
public protocol MailboxSource: Sendable {
    func read(mailboxId: String) async throws -> Data?
}

/// `Documents/Yachiyo` in iCloud Drive, reached through a security-scoped bookmark saved when the
/// user picked the folder. Reads download the file first and go through NSFileCoordinator.
public final class BookmarkedFolderMailboxSource: MailboxSource, @unchecked Sendable {
    public enum FolderError: Error { case wrongFolder }

    private let bookmark: Data

    public init(bookmark: Data) {
        self.bookmark = bookmark
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

    public func read(mailboxId: String) async throws -> Data? {
        var stale = false
        let folder = try URL(resolvingBookmarkData: bookmark, options: Self.bookmarkResolutionOptions, relativeTo: nil, bookmarkDataIsStale: &stale)
        let accessing = folder.startAccessingSecurityScopedResource()
        defer { if accessing { folder.stopAccessingSecurityScopedResource() } }
        let file = folder.appendingPathComponent("Remote").appendingPathComponent("\(mailboxId).box")
        try? FileManager.default.startDownloadingUbiquitousItem(at: file)
        var coordinationError: NSError?
        var result: Data?
        NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &coordinationError) { url in
            result = try? Data(contentsOf: url)
        }
        if let coordinationError, coordinationError.code != NSFileReadNoSuchFileError {
            throw coordinationError
        }
        return result
    }

    #if os(macOS)
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = [.withSecurityScope]
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
    #else
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = []
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = []
    #endif
}
