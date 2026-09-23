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
        XCTAssertEqual(ToolHintView.height(isExpanded: true), ToolHintView.height(isExpanded: false))
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

    @MainActor
    func testSubmissionRetainsDraftAndFileUntilDelayedAcknowledgement() async throws {
        let input = ChatInputView()
        let delegate = DelayedSubmissionDelegate()
        input.delegate = delegate
        input.bind(conversationID: UUID().uuidString)
        defer { input.storage.removeAll() }
        let file = input.storage.fileURL(for: "pending.txt")
        try Data("attachment".utf8).write(to: file)
        let attachment = ChatInputAttachment(type: .document, storageFilename: "pending.txt")
        input.refill(withText: "  pending draft  ", attachments: [attachment])

        input.submit(options: [:])

        XCTAssertTrue(input.isSubmitting)
        XCTAssertEqual(input.inputEditor.textView.text, "  pending draft  ")
        XCTAssertEqual(input.collectObject().attachments, [attachment])
        XCTAssertTrue(input.inputEditor.textView.isEditable)
        XCTAssertTrue(input.inputEditor.submissionSpinner.isAnimating)
        XCTAssertEqual(try Data(contentsOf: file), Data("attachment".utf8))
        XCTAssertEqual(delegate.submissions.count, 1)

        delegate.completions[0](true)
        await waitForSubmissionCompletion(input)

        XCTAssertEqual(input.collectObject().text, "")
        XCTAssertTrue(input.collectObject().attachments.isEmpty)
        XCTAssertFalse(input.inputEditor.submissionSpinner.isAnimating)
        // Shared temp storage is not bulk-deleted, even after ACK.
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    @MainActor
    func testRejectedSubmissionLeavesExactDraftAndAttachmentsUntouched() async {
        let input = ChatInputView()
        let delegate = DelayedSubmissionDelegate()
        input.delegate = delegate
        let attachment = ChatInputAttachment(type: .document, textContent: "attachment")
        input.refill(withText: "  keep whitespace\n", attachments: [attachment])
        input.submit(options: [:])
        delegate.completions[0](false)
        await waitForSubmissionCompletion(input)
        XCTAssertEqual(input.inputEditor.textView.text, "  keep whitespace\n")
        XCTAssertEqual(input.collectObject().attachments, [attachment])
    }

    @MainActor
    func testAcknowledgementDoesNotClearTextEditedDuringSubmission() async {
        let input = ChatInputView()
        let delegate = DelayedSubmissionDelegate()
        input.delegate = delegate
        input.refill(withText: "  draft  ", attachments: [])
        input.submit(options: [:])
        // The collected, trimmed object is identical: comparison must use exact editor text.
        input.refill(withText: "draft", attachments: [])
        delegate.completions[0](true)
        await waitForSubmissionCompletion(input)
        XCTAssertEqual(input.inputEditor.textView.text, "draft")
    }

    @MainActor
    func testAcknowledgementDoesNotClearNewOrEditedAttachments() async throws {
        let input = ChatInputView()
        let delegate = DelayedSubmissionDelegate()
        input.delegate = delegate
        input.bind(conversationID: UUID().uuidString)
        defer { input.storage.removeAll() }
        var original = ChatInputAttachment(type: .document, textContent: "before")
        input.refill(withText: "draft", attachments: [original])
        input.submit(options: [:])
        original.textContent = "edited with the same ID"
        let added = ChatInputAttachment(type: .document, storageFilename: "new.txt")
        let addedFile = input.storage.fileURL(for: added.storageFilename)
        try Data("new asset".utf8).write(to: addedFile)
        input.refill(withText: "draft", attachments: [original, added])
        delegate.completions[0](true)
        await waitForSubmissionCompletion(input)
        XCTAssertEqual(input.collectObject().attachments, [original, added])
        XCTAssertEqual(try Data(contentsOf: addedFile), Data("new asset".utf8))
    }

    @MainActor
    func testDuplicateSubmitAndDuplicateCompletionDoNotResendOrClearDraft() async {
        let input = ChatInputView()
        let delegate = DelayedSubmissionDelegate()
        input.delegate = delegate
        input.refill(withText: "first", attachments: [])
        input.submit(options: [:])
        input.submit(options: ["sendMode": .string("queue")])
        XCTAssertEqual(delegate.submissions.count, 1)
        let firstCompletion = delegate.completions[0]
        firstCompletion(false)
        await waitForSubmissionCompletion(input)

        input.refill(withText: "second", attachments: [])
        input.submit(options: [:])
        firstCompletion(true)
        let staleClearedNewSubmission = expectation(for: NSPredicate { _, _ in !input.isSubmitting }, evaluatedWith: input)
        staleClearedNewSubmission.isInverted = true
        await fulfillment(of: [staleClearedNewSubmission], timeout: 0.1)
        XCTAssertEqual(input.collectObject().text, "second")
        XCTAssertEqual(delegate.submissions.count, 2)
        delegate.completions[1](true)
        await waitForSubmissionCompletion(input)
        XCTAssertTrue(input.collectObject().hasEmptyContent)
    }

    @MainActor
    func testSessionRebindIgnoresPreviousAcknowledgement() async {
        let input = ChatInputView()
        let delegate = DelayedSubmissionDelegate()
        input.delegate = delegate
        input.bind(conversationID: "old")
        input.refill(withText: "identical text", attachments: [])
        input.submit(options: [:])
        let oldCompletion = delegate.completions[0]

        input.bind(conversationID: "new")
        XCTAssertFalse(input.isSubmitting)
        input.refill(withText: "identical text", attachments: [])
        input.submit(options: [:])
        oldCompletion(true)
        let staleClearedNewSession = expectation(for: NSPredicate { _, _ in !input.isSubmitting }, evaluatedWith: input)
        staleClearedNewSession.isInverted = true
        await fulfillment(of: [staleClearedNewSession], timeout: 0.1)
        XCTAssertEqual(input.collectObject().text, "identical text")
        delegate.completions[1](false)
        await waitForSubmissionCompletion(input)
        XCTAssertEqual(input.collectObject().text, "identical text")
    }

    @MainActor
    func testNilDelegateDoesNotClearDraftOrStartSubmission() {
        let input = ChatInputView()
        input.refill(withText: "still here", attachments: [])
        input.submit(options: [:])
        XCTAssertEqual(input.collectObject().text, "still here")
        XCTAssertFalse(input.isSubmitting)
    }

    @MainActor
    private func waitForSubmissionCompletion(_ input: ChatInputView) async {
        let completed = expectation(for: NSPredicate { _, _ in !input.isSubmitting }, evaluatedWith: input)
        await fulfillment(of: [completed], timeout: 2)
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

@MainActor
private final class DelayedSubmissionDelegate: ChatInputDelegate {
    var submissions: [ChatInputContent] = []
    var completions: [@Sendable (Bool) -> Void] = []

    func chatInputDidSubmit(_ input: ChatInputView, object: ChatInputContent, completion: @escaping @Sendable (Bool) -> Void) {
        submissions.append(object)
        completions.append(completion)
    }
}
