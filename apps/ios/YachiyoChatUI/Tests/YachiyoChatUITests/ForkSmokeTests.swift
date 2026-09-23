import Combine
import UIKit
import XCTest
@testable import YachiyoChatUI

final class ForkSmokeTests: XCTestCase {
    @MainActor
    func testCachedMessagesRenderWithoutWaitingForANetworkEvent() async {
        let source = CachedMessageSource()
        let list = MessageListView()
        list.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        list.session = source
        let rendered = expectation(for: NSPredicate { _, _ in list.alpha == 1 }, evaluatedWith: list)
        await fulfillment(of: [rendered], timeout: 3)
    }

    func testConversationMessageTextContentRoundTrips() {
        let message = ConversationMessage(conversationID: "thread", role: .assistant)
        message.textContent = "Hello"
        XCTAssertEqual(message.textContent, "Hello")
    }

    @MainActor
    func testToolDeckGroupsCallsAndRetainsSelection() {
        let list = MessageListView()
        let message = ConversationMessage(conversationID: "thread", role: .assistant)
        let first = ToolCallContentPart(id: "first", toolName: "read", state: .succeeded)
        let second = ToolCallContentPart(id: "second", toolName: "bash")
        message.parts = [.toolCall(first), .toolCall(second)]
        list.selectedToolCalls[message.id] = first.id
        let decks = list.entries(from: [message]).filter {
            if case .toolCallHint = $0 { return true }
            return false
        }
        XCTAssertEqual(decks.count, 1)
        guard case let .toolCallHint(id, calls, selectedID) = decks.first else {
            return XCTFail("Expected a grouped tool deck")
        }
        XCTAssertEqual(id, message.id)
        XCTAssertEqual(calls.map(\.id), [first.id, second.id])
        XCTAssertEqual(selectedID, first.id)
        XCTAssertEqual(ToolHintView.summaryCall(in: calls)?.id, second.id)

        message.parts = [.toolCall(second)]
        guard case let .toolCallHint(_, _, removedSelection) = list.entries(from: [message]).last else {
            return XCTFail("Expected a tool deck after removal")
        }
        XCTAssertNil(removedSelection)
    }

    @MainActor
    func testToolDeckPrefersLatestRunningCallAndFallsBackToLatest() {
        let running = ToolCallContentPart(id: "running", toolName: "bash")
        let completed = ToolCallContentPart(id: "done", toolName: "read", state: .succeeded)
        XCTAssertEqual(ToolHintView.summaryCall(in: [running, completed])?.id, running.id)
        XCTAssertEqual(ToolHintView.summaryCall(in: [completed])?.id, completed.id)
        XCTAssertNil(ToolHintView.summaryCall(in: []))
        XCTAssertGreaterThan(ToolHintView.height(isExpanded: true), ToolHintView.height(isExpanded: false))
    }

    func testToolPreviewChangesInvalidateDeckSnapshot() {
        let original = ToolCallContentPart(id: "call", toolName: "read", parameters: "before")
        var updated = original
        updated.parameters = "after"
        XCTAssertNotEqual(original, updated)
        XCTAssertEqual(Set([original, updated]).count, 2)
    }

    @MainActor
    func testToolDeckUsesAvailableSystemSymbols() {
        let names = ["read", "write", "edit", "bash", "jsRepl", "pyRepl", "grep", "glob",
                     "webRead", "useBrowser", "webSearch", "skillsRead", "applyPatch", "useSentinel",
                     "askUser", "delegateTask", "remember", "querySource", "useThings", "reviewThings",
                     "updateProfile", "updateTodoList", "sendThreadMessage", "steerTask", "getTask",
                     "exitPlanMode", "unknown"]
        for name in names {
            XCTAssertNotNil(UIImage(systemName: ToolHintView.symbol(for: name)), name)
        }
    }
}

@MainActor
private final class CachedMessageSource: ChatMessageSource {
    let messages: [ConversationMessage]
    var messagesDidChange: AnyPublisher<([ConversationMessage], Bool), Never> {
        Empty(completeImmediately: false).eraseToAnyPublisher()
    }
    var userDidSendMessage: AnyPublisher<Void, Never> {
        Empty(completeImmediately: false).eraseToAnyPublisher()
    }
    init() {
        let message = ConversationMessage(conversationID: "cached-thread", role: .assistant)
        message.textContent = "Available offline"
        messages = [message]
    }
    func message(for id: String) -> ConversationMessage? { messages.first { $0.id == id } }
    func notifyMessagesDidChange(scrolling: Bool) {}
}
