import XCTest

final class LaunchTests: XCTestCase {
    func testAppLaunches() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.navigationBars["Yachiyo"].waitForExistence(timeout: 10))
    }
}
