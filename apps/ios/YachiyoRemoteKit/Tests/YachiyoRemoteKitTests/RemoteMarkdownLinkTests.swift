import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class RemoteMarkdownLinkTests: XCTestCase {
    func testOrdinaryURLsOpenExternally() {
        XCTAssertEqual(RemoteMarkdownLink("https://example.com/help?q=1#part"), .external(URL(string: "https://example.com/help?q=1#part")!))
        XCTAssertEqual(RemoteMarkdownLink("mailto:person@example.com"), .external(URL(string: "mailto:person@example.com")!))
        XCTAssertEqual(RemoteMarkdownLink("//example.com/photo.png"), .external(URL(string: "https://example.com/photo.png")!))
    }

    func testMacFileLinksUseAuthenticatedWorkspaceFetch() {
        XCTAssertEqual(RemoteMarkdownLink("./output/photo.png"), .workspaceFile("./output/photo.png"))
        XCTAssertEqual(RemoteMarkdownLink("/Users/me/work/photo%20one.png"), .workspaceFile("/Users/me/work/photo%20one.png"))
        XCTAssertEqual(RemoteMarkdownLink("file:///Users/me/work/photo.png"), .workspaceFile("file:///Users/me/work/photo.png"))
        XCTAssertEqual(RemoteMarkdownLink("output/photo one.png"), .workspaceFile("output/photo one.png"))
    }

    func testUnsafeSchemesAndEmptyTargetsAreNotOpened() {
        XCTAssertEqual(RemoteMarkdownLink("javascript:alert(1)"), .unsupported)
        XCTAssertEqual(RemoteMarkdownLink("data:text/html,test"), .unsupported)
        XCTAssertEqual(RemoteMarkdownLink(""), .unsupported)
        XCTAssertEqual(RemoteMarkdownLink("#heading"), .unsupported)
    }
}
