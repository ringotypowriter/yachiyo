import XCTest
@testable import YachiyoRemoteKit

final class RemoteDesktopSelectionTests: XCTestCase {
    func testSavedSelectionWinsOverPrimaryAndOrdering() {
        XCTAssertEqual(RemoteDesktopSelection.resolve(savedId: "second", desktopIds: ["first", "second"], primaryId: "first"), "second")
        XCTAssertEqual(RemoteDesktopSelection.resolve(savedId: "second", desktopIds: ["second", "first"], primaryId: "first"), "second")
    }

    func testMissingOrForgottenSelectionDefaultsToPrimary() {
        for savedId: String? in [nil, "forgotten"] {
            XCTAssertEqual(RemoteDesktopSelection.resolve(savedId: savedId, desktopIds: ["first", "primary"], primaryId: "primary"), "primary")
        }
    }

    func testMissingPrimaryFallsBackToFirstPairedDesktop() {
        XCTAssertEqual(RemoteDesktopSelection.resolve(savedId: "forgotten", desktopIds: ["first", "second"], primaryId: "forgotten"), "first")
        XCTAssertNil(RemoteDesktopSelection.resolve(savedId: "forgotten", desktopIds: [], primaryId: "forgotten"))
    }

    func testSelectionSurvivesUntilDesktopIsForgotten() {
        var selected = RemoteDesktopSelection.resolve(savedId: "second", desktopIds: ["first", "second"], primaryId: "first")
        // Connection changes don't change the paired IDs passed to the resolver.
        selected = RemoteDesktopSelection.resolve(savedId: selected, desktopIds: ["first", "second"], primaryId: "first")
        XCTAssertEqual(selected, "second")
        selected = RemoteDesktopSelection.resolve(savedId: selected, desktopIds: ["first"], primaryId: "first")
        XCTAssertEqual(selected, "first")
    }
}
