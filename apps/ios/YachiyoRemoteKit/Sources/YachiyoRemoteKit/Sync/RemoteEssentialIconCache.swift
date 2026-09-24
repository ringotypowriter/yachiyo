import CryptoKit
import Foundation

/// Persistent, best-effort icon cache. Desktop and Essential IDs are hashed into safe filenames;
/// content digests validate disk entries and prevent list/getIcon races from poisoning the cache.
public actor RemoteEssentialIconCache {
    public static let shared = RemoteEssentialIconCache(directory: FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("EssentialIcons", isDirectory: true))

    private let directory: URL
    private var inFlight: [String: Task<Data?, Never>] = [:]

    public init(directory: URL) { self.directory = directory }

    public func imageData(
        desktopId: String, essentialId: String, iconVersion: String?,
        fetch: @escaping @Sendable () async -> RemoteEssentialsGetIconOutput?
    ) async -> Data? {
        let identity = Self.digest(Data("\(desktopId.utf8.count):\(desktopId)\(essentialId)".utf8))
        let url = directory.appendingPathComponent(identity)
        if let iconVersion, let data = try? Data(contentsOf: url), Self.digest(data) == iconVersion {
            return data
        }
        let requestKey = identity + ":" + (iconVersion ?? "legacy")
        if let task = inFlight[requestKey] { return await task.value }
        let task = Task<Data?, Never> {
            guard let output = await fetch(), let data = Data(base64Encoded: output.data) else { return nil }
            // Legacy desktops are deliberately not cached: no version means no safe invalidation.
            // If the source changed after list, display the new bytes but don't cache under the old version.
            if let iconVersion, output.iconVersion == iconVersion, Self.digest(data) == iconVersion {
                do {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    var excluded = directory
                    var values = URLResourceValues()
                    values.isExcludedFromBackup = true
                    try excluded.setResourceValues(values)
                    #if os(iOS)
                    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    #else
                    try data.write(to: url, options: .atomic)
                    #endif
                } catch {
                    // Cache failure is not an image failure; return the downloaded bytes.
                }
            }
            return data
        }
        inFlight[requestKey] = task
        let data = await task.value
        inFlight[requestKey] = nil
        return data
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
