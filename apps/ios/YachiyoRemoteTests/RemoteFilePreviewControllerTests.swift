import QuickLook
import UIKit
import XCTest
import YachiyoRemoteKit
@testable import Yachiyo

@MainActor
final class RemoteFilePreviewControllerTests: XCTestCase {
    private func waitForPreview(_ controller: RemoteFilePreviewController) async throws -> URL {
        for _ in 0..<200 {
            if controller.numberOfPreviewItems(in: QLPreviewController()) == 1 {
                return try XCTUnwrap(controller.previewController(QLPreviewController(), previewItemAt: 0) as? URL)
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Preview did not load")
        throw CocoaError(.fileNoSuchFile)
    }

    func testReopeningUsesCacheAndRefreshButtonFetchesLatestCopy() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = RemoteFilePreviewCache(directory: directory)
        var downloads = 0
        let loader: (Bool) async throws -> RemoteFilePreviewCache.File = { refresh in
            try await cache.file(desktopId: "mac", threadId: "thread", path: "report.txt", refresh: refresh) {
                await MainActor.run {
                    downloads += 1
                    return RemoteFilesGetOutput(data: Data("copy \(downloads)".utf8).base64EncodedString(), filename: "report.txt", mediaType: "text/plain")
                }
            }
        }
        var first: RemoteFilePreviewController? = RemoteFilePreviewController(loadFile: loader)
        first?.loadViewIfNeeded()
        let firstURL = try await waitForPreview(try XCTUnwrap(first))
        XCTAssertEqual(try String(contentsOf: firstURL, encoding: .utf8), "copy 1")
        first = nil
        let reopened = RemoteFilePreviewController(loadFile: loader)
        reopened.loadViewIfNeeded()
        let cachedURL = try await waitForPreview(reopened)
        XCTAssertEqual(downloads, 1)
        XCTAssertEqual(try String(contentsOf: cachedURL, encoding: .utf8), "copy 1")
        let button = try XCTUnwrap(reopened.navigationItem.leftBarButtonItem)
        let action = try XCTUnwrap(button.action)
        XCTAssertTrue(reopened.responds(to: action))
        reopened.perform(action, with: button)
        let refreshedURL = try await waitForPreview(reopened)
        XCTAssertEqual(downloads, 2)
        XCTAssertEqual(try String(contentsOf: refreshedURL, encoding: .utf8), "copy 2")
        XCTAssertEqual(reopened.children.count, 1)
    }
}
