import CryptoKit
import XCTest
@testable import YachiyoRemoteKit

final class RemoteEssentialIconCacheTests: XCTestCase {
    private func fixture(_ text: String) -> RemoteEssentialsGetIconOutput {
        let data = Data(text.utf8)
        let version = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return RemoteEssentialsGetIconOutput(data: data.base64EncodedString(), iconVersion: version, mediaType: "image/png")
    }

    func testPersistsAcrossInstancesAndScopesByDesktopAndContent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = fixture("first")
        let second = fixture("second")
        let cache = RemoteEssentialIconCache(directory: directory)
        _ = await cache.imageData(desktopId: "../mac", essentialId: "icon", iconVersion: first.iconVersion) { first }
        let reopened = RemoteEssentialIconCache(directory: directory)
        let hit = await reopened.imageData(desktopId: "../mac", essentialId: "icon", iconVersion: first.iconVersion) {
            XCTFail("Reopening must not download unchanged icons")
            return nil
        }
        XCTAssertEqual(hit, Data("first".utf8))
        let other = await reopened.imageData(desktopId: "other", essentialId: "icon", iconVersion: first.iconVersion) { nil }
        XCTAssertNil(other)
        let changed = await reopened.imageData(desktopId: "../mac", essentialId: "icon", iconVersion: second.iconVersion) { second }
        XCTAssertEqual(changed, Data("second".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
    }

    func testListFetchRaceDoesNotPoisonOldVersion() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let old = fixture("old")
        let new = fixture("new")
        let cache = RemoteEssentialIconCache(directory: directory)
        let changed = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: old.iconVersion) { new }
        XCTAssertEqual(changed, Data("new".utf8))
        let stale = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: old.iconVersion) { nil }
        XCTAssertNil(stale)
    }

    func testLegacyAndFailedDownloadsAreNotCached() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = fixture("legacy")
        let cache = RemoteEssentialIconCache(directory: directory)
        _ = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: nil) { output }
        let legacy = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: nil) { nil }
        XCTAssertNil(legacy)
        _ = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: output.iconVersion) { nil }
        let retry = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: output.iconVersion) { output }
        XCTAssertEqual(retry, Data("legacy".utf8))
    }

    func testCorruptDiskEntryIsRefetchedAndUnwritableCacheStillReturnsImage() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = fixture("valid")
        let cache = RemoteEssentialIconCache(directory: directory)
        _ = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: output.iconVersion) { output }
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        try Data("corrupt".utf8).write(to: file)
        let repaired = await cache.imageData(desktopId: "mac", essentialId: "icon", iconVersion: output.iconVersion) { output }
        XCTAssertEqual(repaired, Data("valid".utf8))
        let blocked = RemoteEssentialIconCache(directory: file)
        let result = await blocked.imageData(desktopId: "mac", essentialId: "icon", iconVersion: output.iconVersion) { output }
        XCTAssertEqual(result, Data("valid".utf8))
    }
}
