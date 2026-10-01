import Combine
import ListViewKit
import UIKit
import XCTest
@testable import YachiyoChatUI

/// Rows inserted, removed or resized above the reader must not move what the reader is looking at.
@MainActor
final class ReadingAnchorTests: XCTestCase {
    func testOlderPagesKeepTheReadingPositionWhileTheReplyGrows() async {
        let source = HistorySource(messages: (101 ... 150).map(Self.message))
        let list = await makeList(source)
        list.earlierHistory = .available
        await waitForRow(Entry.earlierHistoryID, in: list)
        readHistory(in: list, at: 0.5)
        let anchor = firstVisibleMessageRow(in: list)
        let before = screenY(of: anchor, in: list)

        // Two older pages arrive while the newest reply keeps streaming.
        for page in [51 ... 100, 1 ... 50] {
            source.messages.last?.textContent += "\n\n" + Self.paragraph(page.lowerBound)
            source.messages = page.map(Self.message) + source.messages
            source.publish(scrolling: true)
            await waitForRow("user-m\(page.lowerBound)", in: list)
            XCTAssertEqual(screenY(of: anchor, in: list), before, accuracy: 1)
        }

        let ids = (0 ..< list.dataSource.snapshot().count).compactMap { list.dataSource.snapshot().item(at: $0)?.id }
        XCTAssertEqual(ids.count, Set(ids).count)
        XCTAssertEqual(ids.filter { $0.hasPrefix("user-") }, stride(from: 1, through: 149, by: 2).map { "user-m\($0)" })
        XCTAssertLessThan(list.scrollView.contentOffset.y, listView(list).maximumContentOffset.y - 400)
    }

    func testFollowingTheNewestMessageSurvivesAnOlderPage() async {
        let source = HistorySource(messages: (101 ... 150).map(Self.message))
        let list = await makeList(source)
        XCTAssertEqual(list.scrollView.contentOffset.y, listView(list).maximumContentOffset.y, accuracy: 2)
        let anchor = firstVisibleMessageRow(in: list)
        let before = screenY(of: anchor, in: list)

        source.messages = (51 ... 100).map(Self.message) + source.messages
        source.publish(scrolling: false)
        await waitForRow("user-m51", in: list)

        XCTAssertEqual(screenY(of: anchor, in: list), before, accuracy: 1)
        XCTAssertEqual(list.scrollView.contentOffset.y, listView(list).maximumContentOffset.y, accuracy: 2)
    }

    func testRemovedAnchorFallsBackToTheNextSurvivingRow() async {
        let source = HistorySource(messages: (101 ... 150).map(Self.message))
        let list = await makeList(source)
        readHistory(in: list, at: 0.5)
        let order = (0 ..< list.dataSource.snapshot().count).compactMap { list.dataSource.snapshot().item(at: $0)?.id }
        let visible = listView(list).indicesForVisibleRows.map { order[$0] }
        // A user message is a single row, so removing it removes the anchor row itself.
        let removed = visible.first { $0.hasPrefix("user-") }!
        let removedMessage = String(removed.dropFirst("user-".count))
        let survivor = order.suffix(from: order.firstIndex(of: removed)! + 1).first { $0.hasPrefix("response-") }!
        // Put the row at the top edge so it is the row holding the reading position.
        list.scrollView.setContentOffset(CGPoint(x: 0, y: listView(list).rectForRow(with: removed).minY), animated: false)
        list.scrollView.layoutIfNeeded()
        let before = screenY(of: survivor, in: list)

        source.messages.removeAll { $0.id == removedMessage }
        source.publish(scrolling: false)
        let applied = expectation(for: NSPredicate { _, _ in
            list.dataSource.snapshot().count < order.count
        }, evaluatedWith: nil)
        await fulfillment(of: [applied], timeout: 5)

        XCTAssertEqual(screenY(of: survivor, in: list), before, accuracy: 1)
    }

    func testEarlierHistoryRowAppearsAndLeavesWithoutMovingTheReader() async {
        let source = HistorySource(messages: (101 ... 150).map(Self.message))
        let list = await makeList(source)
        readHistory(in: list, at: 0.5)
        let anchor = firstVisibleMessageRow(in: list)
        let before = screenY(of: anchor, in: list)

        list.earlierHistory = .available
        await waitForRow(Entry.earlierHistoryID, in: list)
        XCTAssertEqual(list.dataSource.snapshot().item(at: 0)?.id, Entry.earlierHistoryID)
        XCTAssertEqual(screenY(of: anchor, in: list), before, accuracy: 1)

        list.earlierHistory = .none
        let removed = expectation(for: NSPredicate { _, _ in
            list.dataSource.snapshot().item(at: 0)?.id != Entry.earlierHistoryID
        }, evaluatedWith: nil)
        await fulfillment(of: [removed], timeout: 5)
        XCTAssertEqual(screenY(of: anchor, in: list), before, accuracy: 1)
    }

    func testEarlierHistoryRowRequestsAndRetriesWithoutAGesture() async {
        let source = HistorySource(messages: (141 ... 150).map(Self.message))
        let list = await makeList(source)
        let delegate = RequestRecorder()
        list.interactionDelegate = delegate

        for state in [EarlierHistoryState.available, .failed] {
            list.earlierHistory = state
            await waitForRow(Entry.earlierHistoryID, in: list)
            list.scrollView.setContentOffset(listView(list).minimumContentOffset, animated: false)
            list.scrollView.layoutIfNeeded()
            let enabled = expectation(for: NSPredicate { _, _ in self.earlierHistoryButton(in: list)?.isEnabled == true }, evaluatedWith: nil)
            await fulfillment(of: [enabled], timeout: 5)
            earlierHistoryButton(in: list)?.sendActions(for: .touchUpInside)
            list.earlierHistory = .loading
            let disabled = expectation(for: NSPredicate { _, _ in self.earlierHistoryButton(in: list)?.isEnabled == false }, evaluatedWith: nil)
            await fulfillment(of: [disabled], timeout: 5)
        }
        XCTAssertEqual(delegate.requests, 2)
    }

    // MARK: Helpers

    private typealias Entry = MessageListView.Entry

    private func makeList(_ source: HistorySource) async -> MessageListView {
        let list = MessageListView()
        list.applyYachiyoTheme()
        list.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        list.layoutIfNeeded()
        list.session = source
        retained.append(source)
        let rendered = expectation(for: NSPredicate { _, _ in list.alpha == 1 }, evaluatedWith: nil)
        await fulfillment(of: [rendered], timeout: 5)
        return list
    }

    /// The list holds its session weakly-by-protocol; keep fixtures alive for the test.
    private var retained: [AnyObject] = []

    private func listView(_ list: MessageListView) -> ListView {
        list.scrollView as! ListView
    }

    /// Leaves follow-the-bottom the way a drag does, then parks the viewport inside the history.
    private func readHistory(in list: MessageListView, at fraction: CGFloat) {
        list.scrollViewWillBeginDragging(list.scrollView)
        let maximum = listView(list).maximumContentOffset.y
        list.scrollView.setContentOffset(CGPoint(x: 0, y: (maximum * fraction).rounded()), animated: false)
        list.scrollView.layoutIfNeeded()
    }

    private func firstVisibleMessageRow(in list: MessageListView) -> String {
        let snapshot = list.dataSource.snapshot()
        return listView(list).indicesForVisibleRows
            .compactMap { snapshot.item(at: $0)?.id }
            .first { $0.hasPrefix("user-") || $0.hasPrefix("response-") }!
    }

    private func screenY(of id: String, in list: MessageListView) -> CGFloat {
        listView(list).rectForRow(with: id).minY - list.scrollView.contentOffset.y
    }

    private func waitForRow(_ id: String, in list: MessageListView) async {
        let applied = expectation(for: NSPredicate { _, _ in
            self.listView(list).rectForRow(with: id) != .zero
        }, evaluatedWith: nil)
        await fulfillment(of: [applied], timeout: 5)
    }

    private func earlierHistoryButton(in list: MessageListView) -> UIButton? {
        var queue: [UIView] = [list]
        while let view = queue.popLast() {
            if let button = view as? UIButton, button.accessibilityIdentifier == "thread.earlierHistory" { return button }
            queue.append(contentsOf: view.subviews)
        }
        return nil
    }

    private static func paragraph(_ index: Int) -> String {
        "Paragraph \(index): " + String(repeating: "history that fills several lines of the timeline. ", count: 3 + index % 4)
    }

    private static func message(_ index: Int) -> ConversationMessage {
        let message = ConversationMessage(
            id: "m\(index)", conversationID: "thread", role: index.isMultiple(of: 2) ? .assistant : .user,
            createdAt: Date(timeIntervalSince1970: 1_790_000_000 + Double(index) * 60)
        )
        message.textContent = index.isMultiple(of: 2)
            ? [paragraph(index), "```swift\nlet value = \(index)\n```", paragraph(index + 1)].joined(separator: "\n\n")
            : "Question \(index)"
        return message
    }
}

@MainActor
private final class HistorySource: ChatMessageSource {
    var messages: [ConversationMessage]
    private let subject = PassthroughSubject<([ConversationMessage], Bool), Never>()
    var messagesDidChange: AnyPublisher<([ConversationMessage], Bool), Never> { subject.eraseToAnyPublisher() }
    var userDidSendMessage: AnyPublisher<Void, Never> { Empty(completeImmediately: false).eraseToAnyPublisher() }

    init(messages: [ConversationMessage]) { self.messages = messages }

    func message(for id: String) -> ConversationMessage? { messages.first { $0.id == id } }
    func notifyMessagesDidChange(scrolling: Bool) { publish(scrolling: scrolling) }
    func publish(scrolling: Bool) { subject.send((messages, scrolling)) }
}

@MainActor
private final class RequestRecorder: MessageListInteractionDelegate {
    var requests = 0
    func messageList(_: MessageListView, answer _: String, toQuestion _: QuestionContentPart) {}
    func messageList(_: MessageListView, plan _: String, action _: PlanCardAction) {}
    func messageList(_: MessageListView, showSiblingOf _: String, offset _: Int) {}
    func messageListDidRequestEarlierHistory(_: MessageListView) { requests += 1 }
}
