import XCTest

/// End-to-end smoke against scripts/remote-dev-harness.ts (started by scripts/ios-ui-smoke.mjs,
/// which passes the pairing URL as TEST_RUNNER_YACHIYO_PAIRING_URL):
/// pair → inbox → open a thread → streamed reply → answer askUser → steer while running → stop →
/// new thread and send.
final class RemoteSmokeTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // Allows rerunning UI-only acceptance against the same isolated, already-paired fixture.
        if ProcessInfo.processInfo.environment["YACHIYO_REUSE_PAIRING"] == "1" {
            app.launchArguments = ["-YachiyoRoute", "inbox"]
            app.launch()
            return
        }
        guard let url = ProcessInfo.processInfo.environment["YACHIYO_PAIRING_URL"], !url.isEmpty else {
            throw XCTSkip("Run through scripts/ios-ui-smoke.mjs so a harness pairing URL is provided.")
        }
        // iPad runs in landscape so the multitasking-sized layout is covered too.
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
        }
        app.launchArguments += ["-YachiyoPairingURL", url]
        app.launch()
    }

    func testPairChatAnswerSteerStopAndStartThread() throws {
        // Continue after deep-link pairing without configuring optional iCloud recovery.
        continueAfterPairing()

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

    /// Screenshot acceptance against the real Remote UI and the latency-enabled demo harness.
    func testRemotePolishScreenshotAcceptance() throws {
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }

        func waitUntil(_ description: String, timeout: TimeInterval = 45, _ condition: @escaping () -> Bool) {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed, description)
        }

        continueAfterPairing()

        // Pairing may already have fetched the inbox behind its sheet. Capture only if visible.
        let inboxLoading = app.staticTexts["Loading threads…"].firstMatch
        if inboxLoading.waitForExistence(timeout: 2), inboxLoading.isHittable {
            capture("01-inbox-loading")
        }
        let list = app.collectionViews["inbox.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 30))
        let firstThread = list.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.thread.'")).firstMatch
        waitUntil("Loaded inbox has a visible thread") { firstThread.exists && firstThread.isHittable }
        capture("02-inbox-loaded")

        // Keep the paired desktop, but remove the pairing launch argument so it cannot reopen.
        app.terminate()
        app.launchArguments = ["-YachiyoRoute", "thread:demo-thread-coding-dispatch"]
        app.launch()
        let loading = element("thread.loadingStatus")
        waitUntil("Conversation loading status is visible with harness RPC latency", timeout: 30) {
            loading.exists && loading.isHittable && loading.label.contains("Loading conversation")
        }
        capture("03-conversation-loading")
        waitUntil("Conversation finishes loading") { !loading.exists }
        let title = app.staticTexts["thread.title"]
        XCTAssertTrue(title.label.contains("Delegate auth review"), "The routed demo thread loaded")
        let timeline = element("thread.timeline")
        XCTAssertTrue(timeline.waitForExistence(timeout: 15))

        // The timeline initially follows the last reply; reveal the preceding real tool deck.
        let summary = element("toolDeck.summary.demo-tool-dispatch-claude")
        for _ in 0..<12 {
            if summary.exists && summary.isHittable && timeline.frame.contains(summary.frame) { break }
            timeline.swipeDown(velocity: .slow)
        }
        waitUntil("Grouped tool deck is on screen", timeout: 10) {
            summary.exists && summary.isHittable && timeline.frame.contains(summary.frame)
        }
        for callID in ["claude", "codex", "bash"] {
            XCTAssertTrue(element("toolDeck.call.demo-tool-dispatch-\(callID)").isHittable, "Grouped deck exposes \(callID)")
        }
        XCTAssertEqual(summary.value as? String, "Collapsed")
        capture("04-tool-deck-collapsed")
        summary.tap()
        let details = element("toolDeck.details.demo-tool-dispatch-claude")
        waitUntil("Tool deck expands") { summary.value as? String == "Expanded" && details.exists }
        for _ in 0..<6 {
            if details.isHittable && timeline.frame.contains(details.frame) { break }
            timeline.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(details.isHittable && timeline.frame.contains(details.frame), "Expanded details are visible")
        capture("05-tool-deck-expanded")

        let draft = "Keep this draft through background recovery."
        let field = app.textViews["composer.text"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText(draft)
        XCTAssertEqual(field.value as? String, draft)
        capture("06-draft-before-background")
        XCUIDevice.shared.press(.home)
        waitUntil("App entered the background", timeout: 10) {
            self.app.state == .runningBackground || self.app.state == .runningBackgroundSuspended
        }
        app.activate()
        waitUntil("Foreground recovery restores the ready conversation and draft") {
            self.app.state == .runningForeground && !loading.exists
                && field.exists && field.value as? String == draft
                && self.element("composer.send").isEnabled
        }
        XCTAssertTrue(title.label.contains("Delegate auth review"), "Recovery preserves the conversation")
        let error = element("thread.error")
        XCTAssertFalse(error.exists && !error.label.isEmpty, "Recovery has no conversation error")
        capture("07-foreground-recovered-draft")
    }

    /// Run with --request-log on the harness to verify these resumes do not repeat snapshots.
    func testCachedConversationSurvivesForegroundResumes() {
        continueAfterPairing()
        let list = app.collectionViews["inbox.list"]
        XCTAssertTrue(list.waitForExistence(timeout: 30))
        let conversation = list.cells["inbox.thread.demo-thread-coding-dispatch"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 30))
        for _ in 0..<8 {
            if conversation.isHittable { break }
            list.swipeUp()
        }
        conversation.tap()
        let deck = element("toolDeck.summary.demo-tool-dispatch-claude")
        XCTAssertTrue(deck.waitForExistence(timeout: 30))
        let loading = element("thread.loadingStatus")
        let ready = NSPredicate(format: "exists == false")
        expectation(for: ready, evaluatedWith: loading)
        waitForExpectations(timeout: 30)
        for _ in 0..<2 {
            XCUIDevice.shared.press(.home)
            app.activate()
            XCTAssertTrue(deck.waitForExistence(timeout: 10), "Cached messages stay visible")
            expectation(for: ready, evaluatedWith: loading)
            waitForExpectations(timeout: 30)
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "cache-resumed-conversation"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Use a fresh harness with --send-delay-ms 6000 and TEST_RUNNER_YACHIYO_MANUAL_SERVER_URL.
    func testDeviceAddressAndDeliveryDiagnostics() throws {
        guard let address = ProcessInfo.processInfo.environment["YACHIYO_MANUAL_SERVER_URL"] else {
            throw XCTSkip("Provide the fixture's replacement server URL.")
        }
        func reveal(_ item: XCUIElement) {
            for _ in 0..<8 {
                if item.isHittable { return }
                app.tables.firstMatch.swipeUp()
            }
        }
        func capture(_ name: String) {
            let image = XCTAttachment(screenshot: app.screenshot())
            image.name = name
            image.lifetime = .keepAlways
            add(image)
        }
        continueAfterPairing()
        app.buttons["inbox.settings"].tap()
        let device = app.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'settings.device.'")).firstMatch
        XCTAssertTrue(device.waitForExistence(timeout: 10))
        device.tap()
        XCTAssertTrue(element("device.savedURL.0").waitForExistence(timeout: 10))
        capture("device-addresses")
        let check = element("device.recovery.check")
        reveal(check)
        check.tap()
        let recovery = element("device.recovery.status")
        XCTAssertTrue(recovery.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "value CONTAINS 'not configured'"), evaluatedWith: recovery)
        waitForExpectations(timeout: 10)
        capture("device-recovery-not-configured")

        let edit = element("device.editAddress")
        for _ in 0..<8 {
            if edit.isHittable { break }
            app.tables.firstMatch.swipeDown()
        }
        edit.tap()
        let addressField = app.textFields["device.editAddress.field"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 10))
        addressField.tap()
        addressField.buttons["Clear text"].tap()
        addressField.typeText("https://user:password@example.test/")
        app.buttons["device.editAddress.save"].tap()
        XCTAssertTrue(element("device.editAddress.error").exists)
        addressField.tap()
        addressField.buttons["Clear text"].tap()
        addressField.typeText(address)
        app.buttons["device.editAddress.save"].tap()
        let connected = element("device.connectedURL")
        XCTAssertTrue(connected.waitForExistence(timeout: 30))
        expectation(for: NSPredicate(format: "label CONTAINS %@ OR value == %@", address, address), evaluatedWith: connected)
        waitForExpectations(timeout: 30)
        capture("device-manual-address-connected")

        app.terminate()
        app.launchArguments = ["-YachiyoRoute", "thread:demo-thread-coding-dispatch"]
        app.launch()
        let field = app.textViews["composer.text"]
        XCTAssertTrue(field.waitForExistence(timeout: 30))
        field.tap()
        field.typeText("Show connection feedback")
        element("composer.send").tap()
        XCTAssertEqual(field.value as? String, "Show connection feedback", "Keep the draft until acknowledgement")
        XCTAssertTrue(element("thread.deliveryStatus").waitForExistence(timeout: 5))
        capture("message-sending-draft-retained")
        expectation(for: NSPredicate(format: "value == ''"), evaluatedWith: field)
        waitForExpectations(timeout: 30)
        capture("message-acknowledged")
    }

    func testCompactToolsAndPhotoLibraryMenu() {
        func capture(_ name: String) {
            let image = XCTAttachment(screenshot: app.screenshot())
            image.name = name
            image.lifetime = .keepAlways
            add(image)
        }
        continueAfterPairing()
        app.terminate()
        app.launchArguments = ["-YachiyoRoute", "thread:demo-thread-coding-dispatch"]
        app.launch()
        let deck = element("toolDeck.summary.demo-tool-dispatch-claude")
        XCTAssertTrue(deck.waitForExistence(timeout: 30))
        let timeline = element("thread.timeline")
        for _ in 0..<8 {
            if deck.isHittable { break }
            timeline.swipeDown()
        }
        capture("compact-tool-deck")
        let start = deck.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let dragY: CGFloat = deck.frame.midY > timeline.frame.midY ? -100 : 100
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: dragY)))
        XCTAssertEqual(deck.value as? String, "Collapsed", "Scrolling from a tool must not expand it")
        deck.tap()
        XCTAssertTrue(element("toolDeck.details.demo-tool-dispatch-claude").exists)
        capture("selected-tool-deck")
        let media = app.buttons["composer.media"]
        XCTAssertTrue(media.waitForExistence(timeout: 10))
        media.tap()
        let library = app.buttons["Photo Library"]
        XCTAssertTrue(library.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Camera"].exists)
        capture("image-source-menu")
        library.tap()
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo' OR label BEGINSWITH 'Image'")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 15), app.debugDescription)
        capture("photo-library-picker")
        photo.tap()
        if app.buttons["Add"].waitForExistence(timeout: 3) { app.buttons["Add"].tap() }
        XCTAssertTrue(app.collectionViews["composer.attachments"].cells.firstMatch.waitForExistence(timeout: 15))
        capture("photo-attached")
    }

    private func continueAfterPairing() {
        if ProcessInfo.processInfo.environment["YACHIYO_REUSE_PAIRING"] == "1" { return }
        XCTAssertTrue(app.staticTexts["pairing.message"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Paired with'")).firstMatch.waitForExistence(timeout: 30))
        let button = app.buttons["pairing.primary"]
        XCTAssertTrue(button.waitForExistence(timeout: 30))
        button.tap()
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
