import CryptoKit
import Foundation

/// Short-lived, bounded disk cache for workspace previews. Without a desktop file version,
/// entries expire after five minutes; an explicit refresh always bypasses the cached copy.
public actor RemoteFilePreviewCache {
    public static let shared = RemoteFilePreviewCache(directory: FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FilePreviews", isDirectory: true))

    public struct File: Codable, Sendable {
        public let filename: String
        public let data: Data
    }

    private struct Entry: Codable {
        let file: File
        let fetchedAt: Date
    }

    private let directory: URL
    private let maxBytes: Int
    private let now: @Sendable () -> Date
    private let lifetime: TimeInterval = 300
    private var requests: [String: UUID] = [:]

    public init(directory: URL, maxBytes: Int = 50 * 1024 * 1024, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.maxBytes = maxBytes
        self.now = now
    }

    public func file(
        desktopId: String, threadId: String, path: String, refresh: Bool = false,
        fetch: @escaping @Sendable () async throws -> RemoteFilesGetOutput
    ) async throws -> File {
        let identity = [desktopId, threadId, path].map { "\($0.utf8.count):\($0)" }.joined()
        let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        try Task.checkCancellation()
        let url = directory.appendingPathComponent(key)
        prune()
        if !refresh, let entry = entry(at: url), now().timeIntervalSince(entry.fetchedAt) >= 0,
           now().timeIntervalSince(entry.fetchedAt) < lifetime {
            return entry.file
        }
        // Failed refreshes must not make a subsequent open silently reuse the old copy.
        try? FileManager.default.removeItem(at: url)
        let request = UUID()
        requests[key] = request
        defer { if requests[key] == request { requests[key] = nil } }
        let output = try await fetch()
        try Task.checkCancellation()
        guard let data = Data(base64Encoded: output.data), data.count <= 6 * 1024 * 1024 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let filename = (output.filename as NSString).lastPathComponent
        guard !filename.isEmpty, filename != ".", filename != ".." else { throw CocoaError(.fileReadInvalidFileName) }
        let file = File(filename: filename, data: data)
        if requests[key] == request {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let encoder = PropertyListEncoder()
                encoder.outputFormat = .binary
                let encoded = try encoder.encode(Entry(file: file, fetchedAt: now()))
                #if os(iOS)
                try encoded.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #else
                try encoded.write(to: url, options: .atomic)
                #endif
                try FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
                prune()
            } catch {
                // A full or unavailable cache must not prevent a successfully downloaded preview.
            }
        }
        return file
    }

    private func entry(at url: URL) -> Entry? {
        guard let data = try? Data(contentsOf: url), data.count <= 7 * 1024 * 1024,
              let entry = try? PropertyListDecoder().decode(Entry.self, from: data),
              entry.file.data.count <= 6 * 1024 * 1024,
              !entry.file.filename.isEmpty, entry.file.filename != ".", entry.file.filename != "..",
              (entry.file.filename as NSString).lastPathComponent == entry.file.filename else { return nil }
        return entry
    }

    private func prune() {
        guard let urls = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else { return }
        var retained: [(url: URL, date: Date, size: Int)] = []
        for url in urls {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
                  let date = values.contentModificationDate, let size = values.fileSize,
                  now().timeIntervalSince(date) >= 0, now().timeIntervalSince(date) < lifetime else {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            retained.append((url, date, size))
        }
        var total = retained.reduce(0) { $0 + $1.size }
        for item in retained.sorted(by: { $0.date < $1.date }) where total > maxBytes {
            try? FileManager.default.removeItem(at: item.url)
            total -= item.size
        }
    }
}
