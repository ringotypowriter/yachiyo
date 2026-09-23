import XCTest

/// End-to-end smoke against scripts/remote-dev-harness.ts (started by scripts/ios-ui-smoke.mjs,
/// which passes the pairing URL as TEST_RUNNER_YACHIYO_PAIRING_URL):
/// pair → inbox → open a thread → streamed reply → answer askUser → steer while running → stop →
/// new thread and send.
final class RemoteSmokeTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let url = ProcessInfo.processInfo.environment["YACHIYO_PAIRING_URL"], !url.isEmpty else {
            throw XCTSkip("Run through scripts/ios-ui-smoke.mjs so a harness pairing URL is provided.")
        }
        // iPad runs in landscape so the multitasking-sized layout is covered too.
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
        }
        app = XCUIApplication()
        app.launchArguments += ["-YachiyoPairingURL", url]
        app.launch()
    }

    func testPairChatAnswerSteerStopAndStartThread() throws {
        // Pairing via the deep link path, then skip the iCloud folder step.
        let skip = app.buttons["pairing.secondary"]
        XCTAssertTrue(app.staticTexts["pairing.message"].waitForExistence(timeout: 30))
        XCTAssertTrue(skip.waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Paired with'")).firstMatch.waitForExistence(timeout: 30))
        skip.tap()

        // The inbox lists the fake desktop's threads.
        let list = app.collectionViews["inbox.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 15))
        let firstThread = list.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.thread.'")).firstMatch
        XCTAssertTrue(firstThread.waitForExistence(timeout: 30), "inbox shows the desktop's threads")
        firstThread.tap()

        // Send a message whose scripted reply streams, then asks a question.
        XCTAssertTrue(element("thread.timeline").waitForExistence(timeout: 15))
        send("ask: Continue with the plan?")
        let yes = element("question.choice.Yes")
        XCTAssertTrue(yes.waitForExistence(timeout: 30), "question card appears")
        XCTAssertTrue(element("composer.stop").exists, "run is active while the question waits")
        yes.tap()
        let answered = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH '· Yes'")).firstMatch
        XCTAssertTrue(answered.waitForExistence(timeout: 30), "answered question collapses")

        // A slow run: steer it, then stop it.
        send("slow: keep streaming")
        let stop = element("composer.stop")
        XCTAssertTrue(stop.waitForExistence(timeout: 30), "stop appears while running")
        send("steer: shorter please")
        let error = element("thread.error")
        XCTAssertFalse(error.exists && !error.label.isEmpty, "steer is accepted: \(error.exists ? error.label : "")")
        stop.tap()
        let stopGone = NSPredicate(format: "exists == false")
        expectation(for: stopGone, evaluatedWith: element("composer.stop"))
        waitForExpectations(timeout: 30)

        // New thread from the inbox toolbar.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let newThread = app.buttons["inbox.new"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 10))
        newThread.tap()
        send("hello from the phone")
        XCTAssertTrue(app.staticTexts["thread.title"].waitForExistence(timeout: 30), "new thread opens after the first send")
        XCTAssertTrue(element("thread.timeline").waitForExistence(timeout: 10))
    }

    /// Matches by identifier regardless of element type (list containers surface as scroll views,
    /// composer buttons as buttons or other elements depending on the glass implementation).
    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func send(_ text: String) {
        let field = app.textViews["composer.text"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText(text)
        let sendButton = element("composer.send")
        XCTAssertTrue(sendButton.waitForExistence(timeout: 10))
        sendButton.tap()
    }
}
