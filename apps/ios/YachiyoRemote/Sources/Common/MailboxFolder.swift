import Foundation
import YachiyoRemoteKit

/// The iCloud Drive `Documents/Yachiyo` folder the user granted for address recovery.
enum MailboxFolder {
    private static let key = "mailboxFolderBookmark"

    static var isGranted: Bool { UserDefaults.standard.data(forKey: key) != nil }

    static func save(folder: URL) throws {
        UserDefaults.standard.set(try BookmarkedFolderMailboxSource.makeBookmark(for: folder), forKey: key)
    }

    static func source() -> MailboxSource? {
        LazyMailboxSource()
    }

    static var iCloudAvailable: Bool { FileManager.default.ubiquityIdentityToken != nil }
}

/// Resolves the bookmark at read time, so granting the folder later still takes effect.
private struct LazyMailboxSource: MailboxSource {
    func read(mailboxId: String) async throws -> Data? {
        guard let bookmark = UserDefaults.standard.data(forKey: "mailboxFolderBookmark") else { throw MailboxReadError.notConfigured }
        return try await BookmarkedFolderMailboxSource(bookmark: bookmark).read(mailboxId: mailboxId)
    }
}
