import UIKit
import XCTest
@testable import YachiyoChatUI

@MainActor
final class ToolHintViewTests: XCTestCase {
    func testGroupedDeckSelectsAndRoutesDetailsWithoutAddingAPreviewPanel() throws {
        let first = ToolCallContentPart(id: "first", toolName: "read", parameters: "Read the project notes", state: .succeeded)
        let second = ToolCallContentPart(id: "second", toolName: "bash", parameters: "Run the tests", state: .succeeded)
        let message = ConversationMessage(conversationID: "thread", role: .assistant)
        message.parts = [.toolCall(first), .toolCall(second)]
        let list = MessageListView()
        let deck = ToolHintView()
        deck.frame = CGRect(x: 0, y: 0, width: 320, height: ToolHintView.height(isExpanded: false))
        deck.onSelect = { list.selectedToolCalls[message.id] = $0 }
        var detailID: String?
        deck.onDetails = { detailID = $0 }

        func render() throws {
            let entries = list.entries(from: [message]).filter {
                if case .toolCallHint = $0 { return true }
                return false
            }
            XCTAssertEqual(entries.count, 1)
            guard case let .toolCallHint(_, calls, selectedID) = entries.first else {
                return XCTFail("Expected grouped tool deck")
            }
            deck.configure(calls: calls, selectedID: selectedID)
            deck.layoutIfNeeded()
        }

        try render()
        let summary = try XCTUnwrap(view("toolDeck.summary.first", in: deck) as? UIButton)
        let details = try XCTUnwrap(view("toolDeck.details.first", in: deck) as? UIButton)
        XCTAssertEqual((view("toolDeck.summaryText", in: summary) as? UILabel)?.text, "Run the tests")
        XCTAssertTrue(details.isHidden)
        summary.sendActions(for: .touchUpInside)
        try render()
        XCTAssertEqual(list.selectedToolCalls[message.id], second.id)
        XCTAssertFalse(details.isHidden)
        XCTAssertGreaterThanOrEqual(details.bounds.height, 44)
        XCTAssertGreaterThanOrEqual(summary.bounds.height, 44)
        XCTAssertEqual((view("toolDeck.summaryText", in: summary) as? UILabel)?.numberOfLines, 2)

        let firstButton = try XCTUnwrap(view("toolDeck.call.first", in: deck) as? UIButton)
        firstButton.sendActions(for: .touchUpInside)
        try render()
        XCTAssertEqual(list.selectedToolCalls[message.id], first.id)
        XCTAssertEqual((view("toolDeck.summaryText", in: summary) as? UILabel)?.text, "Read the project notes")
        XCTAssertEqual(labels(in: deck).filter { $0.text == first.parameters }.count, 1)
        details.sendActions(for: .touchUpInside)
        XCTAssertEqual(detailID, first.id)
        summary.sendActions(for: .touchUpInside)
        try render()
        XCTAssertNil(list.selectedToolCalls[message.id])
        XCTAssertTrue(details.isHidden)
        XCTAssertEqual((view("toolDeck.summaryText", in: summary) as? UILabel)?.text, "Run the tests")
    }

    func testSelectingCompletedCallKeepsOtherRunningAndFailedStatesVisible() throws {
        let completed = ToolCallContentPart(id: "done", toolName: "read", parameters: "Read notes", state: .succeeded)
        let running = ToolCallContentPart(id: "running", toolName: "bash", parameters: "Run tests")
        let failed = ToolCallContentPart(id: "failed", toolName: "write", state: .failed)
        let deck = ToolHintView()
        deck.configure(calls: [completed, running, failed], selectedID: completed.id)
        let summary = try XCTUnwrap(view("toolDeck.summary.done", in: deck) as? UIButton)
        let status = try XCTUnwrap(view("toolDeck.status.done", in: deck) as? UIImageView)
        let activity = try XCTUnwrap(view("toolDeck.activity.done", in: deck) as? UIActivityIndicatorView)
        let reducedMotionStatus = try XCTUnwrap(view("toolDeck.running.done", in: deck))
        let details = try XCTUnwrap(view("toolDeck.details.done", in: deck) as? UIButton)
        XCTAssertEqual((view("toolDeck.summaryText", in: summary) as? UILabel)?.text, "Read notes")
        XCTAssertFalse(status.isHidden)
        XCTAssertEqual(status.tintColor, .systemRed)
        XCTAssertTrue(activity.isAnimating || !reducedMotionStatus.isHidden)
        XCTAssertTrue(summary.accessibilityLabel?.contains("bash") == true)
        XCTAssertTrue(summary.accessibilityLabel?.contains("write") == true)
        XCTAssertTrue(details.isEnabled)

        deck.configure(calls: [completed, running, failed], selectedID: running.id)
        XCTAssertFalse(details.isEnabled)
        deck.configure(calls: [completed], selectedID: nil)
        XCTAssertFalse(activity.isAnimating)
        XCTAssertTrue(reducedMotionStatus.isHidden)
        XCTAssertEqual(status.tintColor, .secondaryLabel)
    }

    func testTimelineAndIconStripCancelButtonTouchesWhenScrolling() throws {
        let list = MessageListView()
        let deck = ToolHintView()
        let call = ToolCallContentPart(id: "call", toolName: "read", state: .succeeded)
        deck.configure(calls: [call], selectedID: nil)
        let summary = try XCTUnwrap(view("toolDeck.summary.call", in: deck) as? UIButton)
        let icon = try XCTUnwrap(view("toolDeck.call.call", in: deck) as? UIButton)
        let iconStrip = try XCTUnwrap(icon.nearestScrollView)
        XCTAssertTrue(list.scrollView.delaysContentTouches)
        XCTAssertTrue(list.scrollView.canCancelContentTouches)
        XCTAssertTrue(list.scrollView.panGestureRecognizer.cancelsTouchesInView)
        XCTAssertTrue(list.scrollView.touchesShouldCancel(in: summary))
        XCTAssertTrue(list.scrollView.touchesShouldCancel(in: icon))
        XCTAssertTrue(iconStrip.delaysContentTouches)
        XCTAssertTrue(iconStrip.canCancelContentTouches)
        XCTAssertTrue(iconStrip.panGestureRecognizer.cancelsTouchesInView)
        XCTAssertTrue(iconStrip.touchesShouldCancel(in: icon))
        let slider = UISlider()
        XCTAssertEqual(list.scrollView.touchesShouldCancel(in: slider), UIScrollView().touchesShouldCancel(in: slider))

        var selectionCount = 0
        deck.onSelect = { _ in selectionCount += 1 }
        summary.sendActions(for: .touchDown)
        summary.sendActions(for: .touchCancel)
        icon.sendActions(for: .touchDown)
        icon.sendActions(for: .touchCancel)
        XCTAssertEqual(selectionCount, 0)
        summary.sendActions(for: .touchUpInside)
        XCTAssertEqual(selectionCount, 1)
    }

    func testLongToolSummariesStayWithinTwoLinesAndKeepDetailsReachable() throws {
        let contents = [
            String(repeating: "Inspect a long tool result and its metadata. ", count: 80),
            String(repeating: "/a-very-long-unbroken-path", count: 160),
            String(repeating: "{\"field\":\"value\"}\n", count: 100),
        ]
        for width: CGFloat in [280, 320, 390] {
            for content in contents {
                let call = ToolCallContentPart(id: "long", toolName: "read", parameters: content, state: .succeeded)
                let deck = ToolHintView()
                deck.frame = CGRect(x: 0, y: 0, width: width, height: ToolHintView.height(isExpanded: true) + MessageListView.listRowInsets.bottom)
                deck.configure(calls: [call], selectedID: call.id)
                deck.layoutIfNeeded()
                let summary = try XCTUnwrap(view("toolDeck.summary.long", in: deck) as? UIButton)
                let text = try XCTUnwrap(view("toolDeck.summaryText", in: summary) as? UILabel)
                let chevron = try XCTUnwrap(view("toolDeck.summaryChevron", in: summary))
                let details = try XCTUnwrap(view("toolDeck.details.long", in: deck) as? UIButton)
                XCTAssertTrue(summary.bounds.contains(text.frame))
                XCTAssertTrue(summary.bounds.contains(chevron.frame))
                XCTAssertLessThanOrEqual(text.frame.maxX + 8, chevron.frame.minX)
                XCTAssertLessThanOrEqual(text.bounds.height, ceil(text.font.lineHeight * 2))
                XCTAssertEqual(text.lineBreakMode, .byTruncatingTail)
                XCTAssertTrue(summary.clipsToBounds)
                XCTAssertGreaterThanOrEqual(summary.bounds.height, 44)
                XCTAssertTrue(details.isEnabled)
                XCTAssertTrue(summary.accessibilityLabel?.contains(text.text ?? "") == true)
                var opened: String?
                deck.onDetails = { opened = $0 }
                details.sendActions(for: .touchUpInside)
                XCTAssertEqual(opened, call.id)
                if width == 280 && content.contains("unbroken") {
                    let image = UIGraphicsImageRenderer(size: deck.bounds.size).image { context in
                        UIColor.systemBackground.setFill()
                        context.fill(deck.bounds)
                        deck.layer.render(in: context.cgContext)
                    }
                    let attachment = XCTAttachment(image: image)
                    attachment.name = "long-tool-summary-narrow"
                    attachment.lifetime = .keepAlways
                    add(attachment)
                }
            }
        }
    }

    private func view(_ identifier: String, in root: UIView) -> UIView? {
        if root.accessibilityIdentifier == identifier { return root }
        return root.subviews.lazy.compactMap { self.view(identifier, in: $0) }.first
    }

    private func labels(in root: UIView) -> [UILabel] {
        (root as? UILabel).map { [$0] } ?? root.subviews.flatMap { self.labels(in: $0) }
    }
}
