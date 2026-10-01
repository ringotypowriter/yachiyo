import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class RemoteFilePreviewCacheTests: XCTestCase {
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    private func output(_ text: String, filename: String = "report.pdf") -> RemoteFilesGetOutput {
        RemoteFilesGetOutput(data: Data(text.utf8).base64EncodedString(), filename: filename, mediaType: "application/pdf")
    }

    func testReopeningPersistsAndSeparatesDesktopThreadAndPath() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = RemoteFilePreviewCache(directory: directory)
        let output = output("first")
        _ = try await first.file(desktopId: "mac", threadId: "thread", path: "report.pdf") { output }
        let reopened = RemoteFilePreviewCache(directory: directory)
        let hit = try await reopened.file(desktopId: "mac", threadId: "thread", path: "report.pdf") {
            XCTFail("A fresh cached preview must not download again")
            throw CocoaError(.fileNoSuchFile)
        }
        XCTAssertEqual(hit.data, Data("first".utf8))
        for (desktop, thread, path) in [("other", "thread", "report.pdf"), ("mac", "other", "report.pdf"), ("mac", "thread", "other.pdf")] {
            let other = self.output("other")
            let fetched = try await reopened.file(desktopId: desktop, threadId: thread, path: path) { other }
            XCTAssertEqual(fetched.data, Data("other".utf8))
        }
    }

    func testExpiryAndExplicitRefreshDownloadNewBytes() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let initial = RemoteFilePreviewCache(directory: directory, now: { Date(timeIntervalSince1970: 1000) })
        let old = output("old")
        _ = try await initial.file(desktopId: "mac", threadId: "thread", path: "report") { old }
        let expired = RemoteFilePreviewCache(directory: directory, now: { Date(timeIntervalSince1970: 1301) })
        let new = output("new")
        let fresh = try await expired.file(desktopId: "mac", threadId: "thread", path: "report") { new }
        XCTAssertEqual(fresh.data, Data("new".utf8))
        let latest = output("latest")
        let refreshed = try await expired.file(desktopId: "mac", threadId: "thread", path: "report", refresh: true) { latest }
        XCTAssertEqual(refreshed.data, Data("latest".utf8))
    }

    func testCorruptEntriesAndFailedRefreshAreRetried() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory)
        let value = output("valid")
        _ = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { value }
        let url = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        try Data("corrupt".utf8).write(to: url)
        let repaired = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { value }
        XCTAssertEqual(repaired.data, Data("valid".utf8))
        do {
            _ = try await cache.file(desktopId: "mac", threadId: "thread", path: "report", refresh: true) { throw CocoaError(.fileNoSuchFile) }
            XCTFail("Refresh failures must not silently display stale files")
        } catch { }
        let updated = output("updated")
        let retry = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { updated }
        XCTAssertEqual(retry.data, Data("updated".utf8))
    }

    func testCacheHasSizeBoundAndDoesNotPreventPreviewWhenUnwritable() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory, maxBytes: 2048)
        let value = output(String(repeating: "a", count: 1000), filename: "../../report.pdf")
        for index in 0..<4 {
            let file = try await cache.file(desktopId: "mac", threadId: "thread", path: "\(index)") { value }
            XCTAssertEqual(file.filename, "report.pdf")
        }
        let size = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).reduce(0) { try $0 + Data(contentsOf: $1).count }
        XCTAssertLessThanOrEqual(size, 2048)
        let blocked = directory.appendingPathComponent("not-a-directory")
        try Data().write(to: blocked)
        let uncached = RemoteFilePreviewCache(directory: blocked)
        let file = try await uncached.file(desktopId: "mac", threadId: "thread", path: "report") { value }
        XCTAssertEqual(file.data.count, 1000)
    }

    func testRefreshDoesNotReuseOrGetOverwrittenByAnOlderDownload() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory)
        let started = expectation(description: "Old download started")
        let old = output("old")
        let first = Task {
            try await cache.file(desktopId: "mac", threadId: "thread", path: "report") {
                started.fulfill()
                try await Task.sleep(for: .milliseconds(100))
                return old
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let latest = output("latest")
        let refreshed = try await cache.file(desktopId: "mac", threadId: "thread", path: "report", refresh: true) { latest }
        XCTAssertEqual(refreshed.data, Data("latest".utf8))
        _ = try await first.value
        let cached = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") {
            XCTFail("The older download must not overwrite refreshed cache")
            return old
        }
        XCTAssertEqual(cached.data, Data("latest".utf8))
    }

    func testFailedRefreshDoesNotAllowAnOlderDownloadToRestoreStaleCache() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory)
        let started = expectation(description: "Old download started")
        let old = output("old")
        let first = Task {
            try await cache.file(desktopId: "mac", threadId: "thread", path: "report") {
                started.fulfill()
                try await Task.sleep(for: .milliseconds(100))
                return old
            }
        }
        await fulfillment(of: [started], timeout: 2)
        do {
            _ = try await cache.file(desktopId: "mac", threadId: "thread", path: "report", refresh: true) { throw CocoaError(.fileNoSuchFile) }
            XCTFail("Refresh must report failure")
        } catch { }
        _ = try await first.value
        let latest = output("latest")
        let fetched = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { latest }
        XCTAssertEqual(fetched.data, Data("latest".utf8))
    }

    func testCancellationStopsDownloadAndDoesNotPopulateCache() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory)
        let started = expectation(description: "Download started")
        let value = output("cancelled")
        let download = Task {
            try await cache.file(desktopId: "mac", threadId: "thread", path: "report") {
                started.fulfill()
                // Even a transport that returns after cancellation must not populate disk.
                try? await Task.sleep(for: .milliseconds(100))
                return value
            }
        }
        await fulfillment(of: [started], timeout: 2)
        download.cancel()
        do {
            _ = try await download.value
            XCTFail("Dismissed downloads must be cancelled")
        } catch is CancellationError { }
        let latest = output("latest")
        let fetched = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { latest }
        XCTAssertEqual(fetched.data, Data("latest".utf8))
    }

    func testInvalidAndOversizedPayloadsAreNeverCached() async throws {
        let directory = directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory)
        for value in [RemoteFilesGetOutput(data: "!", filename: "report", mediaType: "text/plain"), output("data", filename: ".."), output(String(repeating: "a", count: 6 * 1024 * 1024 + 1))] {
            do {
                _ = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { value }
                XCTFail("Invalid payload must fail before caching")
            } catch { }
        }
        let valid = output("valid")
        let retry = try await cache.file(desktopId: "mac", threadId: "thread", path: "report") { valid }
        XCTAssertEqual(retry.data, Data("valid".utf8))
    }
}
