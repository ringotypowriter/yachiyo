import UIKit
import XCTest
@testable import YachiyoChatUI

@MainActor
private final class SubmissionDelegate: ChatInputDelegate {
    var completion: (@Sendable (Bool) -> Void)?

    func chatInputDidSubmit(_: ChatInputView, object _: ChatInputContent, completion: @escaping @Sendable (Bool) -> Void) {
        self.completion = completion
    }
}

final class ChatInputSubmissionTests: XCTestCase {
    @MainActor
    func testSuccessfulSendDismissesKeyboardAndClearsDraft() async {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let input = ChatInputView()
        let delegate = SubmissionDelegate()
        input.delegate = delegate
        window.addSubview(input)
        input.frame = CGRect(x: 0, y: 700, width: 390, height: 100)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        input.inputEditor.set(text: "Hello")
        input.focus()
        XCTAssertTrue(input.inputEditor.textView.isFirstResponder)
        input.submit(options: [:])
        delegate.completion?(true)
        await Task.yield()
        XCTAssertEqual(input.inputEditor.textView.text, "")
        XCTAssertFalse(input.inputEditor.textView.isFirstResponder)
    }

    @MainActor
    func testRejectedSendKeepsKeyboardAndDraft() async {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let input = ChatInputView()
        let delegate = SubmissionDelegate()
        input.delegate = delegate
        window.addSubview(input)
        input.frame = CGRect(x: 0, y: 700, width: 390, height: 100)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        input.inputEditor.set(text: "Hello")
        input.focus()
        input.submit(options: [:])
        delegate.completion?(false)
        await Task.yield()
        XCTAssertEqual(input.inputEditor.textView.text, "Hello")
        XCTAssertTrue(input.inputEditor.textView.isFirstResponder)
    }

    @MainActor
    func testSuccessfulSendDoesNotDismissKeyboardWhileWritingNextMessage() async {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let input = ChatInputView()
        let delegate = SubmissionDelegate()
        input.delegate = delegate
        window.addSubview(input)
        input.frame = CGRect(x: 0, y: 700, width: 390, height: 100)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        input.inputEditor.set(text: "First")
        input.focus()
        input.submit(options: [:])
        input.inputEditor.set(text: "Next")
        delegate.completion?(true)
        await Task.yield()
        XCTAssertEqual(input.inputEditor.textView.text, "Next")
        XCTAssertTrue(input.inputEditor.textView.isFirstResponder)
    }
}
