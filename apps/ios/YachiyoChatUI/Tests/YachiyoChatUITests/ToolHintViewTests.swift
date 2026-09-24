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
        deck.frame = CGRect(x: 0, y: 0, width: 320, height: ToolHintView.height(width: 320 - MessageListView.listRowInsets.horizontal, callCount: 2, isExpanded: false))
        deck.onSelect = { list.selectedToolCalls[message.id] = $0 }
        var detailID: String?
        deck.onDetails = { detailID = $0 }

        func render() throws {
            let entries = list.entries(from: [message]).filter {
                if case .toolCallHint = $0 { return true }
                return false
            }
            XCTAssertEqual(entries.count, 1)
            guard case let .toolCallHint(_, calls, selectedID, showsAll) = entries.first else {
                return XCTFail("Expected grouped tool deck")
            }
            deck.configure(calls: calls, selectedID: selectedID, showsAll: showsAll)
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

    func testTimelineCancelsWrappedIconTouchesWhenScrolling() throws {
        let list = MessageListView()
        let deck = ToolHintView()
        let call = ToolCallContentPart(id: "call", toolName: "read", state: .succeeded)
        deck.configure(calls: [call], selectedID: nil)
        let summary = try XCTUnwrap(view("toolDeck.summary.call", in: deck) as? UIButton)
        let icon = try XCTUnwrap(view("toolDeck.call.call", in: deck) as? UIButton)
        XCTAssertNil(icon.nearestScrollView, "Wrapped icons must not introduce a nested scroll view")
        XCTAssertTrue(list.scrollView.delaysContentTouches)
        XCTAssertTrue(list.scrollView.canCancelContentTouches)
        XCTAssertTrue(list.scrollView.panGestureRecognizer.cancelsTouchesInView)
        XCTAssertTrue(list.scrollView.touchesShouldCancel(in: summary))
        XCTAssertTrue(list.scrollView.touchesShouldCancel(in: icon))
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
                deck.frame = CGRect(x: 0, y: 0, width: width, height: ToolHintView.height(width: width - MessageListView.listRowInsets.horizontal, callCount: 1, isExpanded: true) + MessageListView.listRowInsets.bottom)
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

    func testWrappingHeightChangesAtExactColumnBoundary() {
        let oneRow = ToolHintView.height(width: 132, callCount: 3, isExpanded: false)
        XCTAssertEqual(ToolHintView.height(width: 131, callCount: 3, isExpanded: false), oneRow + 44)
        XCTAssertEqual(ToolHintView.height(width: 132, callCount: 4, isExpanded: false), oneRow + 44)
        XCTAssertEqual(ToolHintView.height(width: 44, callCount: 3, isExpanded: false), oneRow + 44)
        XCTAssertEqual(ToolHintView.height(width: 0, callCount: 3, isExpanded: false), oneRow + 44)
        XCTAssertEqual(ToolHintView.height(width: 0, callCount: 0, isExpanded: false), oneRow)
    }

    func testWrappedIconsAndDetailsFitMeasuredHeightAfterResizeAndSelection() throws {
        let calls = (0..<13).map { ToolCallContentPart(id: "call\($0)", toolName: "read", state: .succeeded) }
        let deck = ToolHintView()
        for width: CGFloat in [320, 132, 96, 44, 390] {
            for expanded in [false, true] {
                let height = ToolHintView.height(width: width, callCount: calls.count, isExpanded: expanded, showsAll: true)
                deck.frame = CGRect(x: 0, y: 0, width: width + MessageListView.listRowInsets.horizontal,
                                    height: height + MessageListView.listRowInsets.bottom)
                deck.configure(calls: calls, selectedID: expanded ? calls[0].id : nil, showsAll: true)
                deck.layoutIfNeeded()
                let summary = try XCTUnwrap(view("toolDeck.summary.call0", in: deck))
                let details = try XCTUnwrap(view("toolDeck.details.call0", in: deck))
                let icons = try calls.map { try XCTUnwrap(view("toolDeck.call.\($0.id)", in: deck)) }
                XCTAssertEqual(summary.frame.maxY, height)
                XCTAssertGreaterThan(icons.last!.frame.minY, 0)
                for (index, icon) in icons.enumerated() {
                    let frame = icon.convert(icon.bounds, to: deck.contentView)
                    XCTAssertEqual(frame.size, CGSize(width: 44, height: 44))
                    XCTAssertTrue(deck.contentView.bounds.contains(frame))
                    XCTAssertLessThanOrEqual(frame.maxY, summary.frame.minY)
                    if expanded { XCTAssertFalse(frame.intersects(details.frame)) }
                    for other in icons.dropFirst(index + 1) {
                        XCTAssertFalse(icon.frame.intersects(other.frame))
                    }
                }
                if expanded {
                    XCTAssertTrue(deck.contentView.bounds.contains(details.frame))
                    XCTAssertGreaterThanOrEqual(details.frame.width, 44)
                    XCTAssertEqual(details.frame.height, 44)
                    XCTAssertLessThanOrEqual(details.frame.maxY, summary.frame.minY)
                }
            }
        }
    }

    func testLongToolDeckShowsRecentCallsInTwoRowsUntilExpanded() throws {
        let calls = (0..<120).map { ToolCallContentPart(id: "call\($0)", toolName: "read", state: .succeeded) }
        let width: CGFloat = 320
        let contentWidth = width - MessageListView.listRowInsets.horizontal
        let compactHeight = ToolHintView.height(width: contentWidth, callCount: calls.count, isExpanded: false)
        XCTAssertEqual(compactHeight, 44 * 3)
        let deck = ToolHintView()
        deck.frame = CGRect(x: 0, y: 0, width: width, height: compactHeight + MessageListView.listRowInsets.bottom)
        deck.configure(calls: calls, selectedID: nil)
        deck.layoutIfNeeded()
        let more = try XCTUnwrap(view("toolDeck.overflow", in: deck) as? UIButton)
        XCTAssertFalse(more.isHidden)
        XCTAssertEqual(more.configuration?.title, "+109")
        XCTAssertTrue(view("toolDeck.call.call0", in: deck)?.isHidden == true)
        XCTAssertFalse(try XCTUnwrap(view("toolDeck.call.call119", in: deck)).isHidden)

        var expandCount = 0
        deck.onToggleAll = { expandCount += 1 }
        more.sendActions(for: .touchUpInside)
        XCTAssertEqual(expandCount, 1)
        let expandedHeight = ToolHintView.height(width: contentWidth, callCount: calls.count, isExpanded: false, showsAll: true)
        XCTAssertGreaterThan(expandedHeight, compactHeight)
        deck.frame.size.height = expandedHeight + MessageListView.listRowInsets.bottom
        deck.configure(calls: calls, selectedID: nil, showsAll: true)
        deck.layoutIfNeeded()
        XCTAssertFalse(try XCTUnwrap(view("toolDeck.call.call0", in: deck)).isHidden)
        XCTAssertEqual(more.accessibilityLabel, "Show fewer tool calls")
        XCTAssertEqual(more.frame.maxY, expandedHeight - 44)
    }

    private func view(_ identifier: String, in root: UIView) -> UIView? {
        if root.accessibilityIdentifier == identifier { return root }
        return root.subviews.lazy.compactMap { self.view(identifier, in: $0) }.first
    }

    private func labels(in root: UIView) -> [UILabel] {
        (root as? UILabel).map { [$0] } ?? root.subviews.flatMap { self.labels(in: $0) }
    }
}
