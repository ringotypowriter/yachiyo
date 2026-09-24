import PhotosUI
import UIKit
import XCTest
@testable import YachiyoChatUI

final class MediaMenuTests: XCTestCase {
    @MainActor
    func testAttachmentEntryRemainsHittableAfterAddingAndCancelling() async {
        let animationsEnabled = UIView.areAnimationsEnabled
        UIView.setAnimationsEnabled(false)
        defer { UIView.setAnimationsEnabled(animationsEnabled) }
        let input = ChatInputView()
        input.widthAnchor.constraint(equalToConstant: 340).isActive = true
        input.frame = CGRect(x: 0, y: 0, width: 340, height: 200)
        let first = ChatInputAttachment(type: .document, textContent: "first")
        input.attachmentsBar.insert(item: first)
        // Allow the composer's debounced draft-layout transition to run.
        try? await Task.sleep(for: .milliseconds(200))
        let editor = input.inputEditor
        editor.frame = CGRect(x: 0, y: 0, width: 320, height: 64)
        editor.layoutIfNeeded()
        assertAttachmentEntryIsHittable(editor)

        editor.moreButton.tapAction()
        XCTAssertTrue(input.controlPanel.isPanelOpen.value)
        input.controlPanel.close()
        input.picker(PHPickerViewController(configuration: PHPickerConfiguration()), didFinishPicking: [])
        editor.frame = CGRect(x: 0, y: 0, width: 320, height: 64)
        editor.layoutIfNeeded()
        assertAttachmentEntryIsHittable(editor)
        editor.moreButton.tapAction()
        XCTAssertTrue(input.controlPanel.isPanelOpen.value)

        let second = ChatInputAttachment(type: .document, textContent: "second")
        input.attachmentsBar.insert(item: second)
        XCTAssertEqual(input.collectObject().attachments, [first, second])
    }

    @MainActor
    func testAttachmentEntryRemainsHittableWithTextDraftAndActiveRun() async {
        let editor = InputEditor()
        editor.set(text: "Unsent draft")
        try? await Task.sleep(for: .milliseconds(200))
        editor.frame = CGRect(x: 0, y: 0, width: 320, height: 64)
        editor.isRunning = true
        editor.layoutIfNeeded()

        assertAttachmentEntryIsHittable(editor)
        XCTAssertEqual(editor.sendButton.alpha, 1)
        XCTAssertEqual(editor.stopButton.alpha, 1)
        XCTAssertFalse(editor.moreButton.frame.intersects(editor.stopButton.frame))
        XCTAssertFalse(editor.moreButton.frame.intersects(editor.sendButton.frame))
    }

    @MainActor
    func testAttachmentEntryRemainsHittableDuringRunWithoutDraft() {
        let editor = InputEditor()
        editor.frame = CGRect(x: 0, y: 0, width: 320, height: 64)
        editor.isRunning = true
        editor.layoutIfNeeded()
        assertAttachmentEntryIsHittable(editor)
        XCTAssertFalse(editor.moreButton.frame.intersects(editor.stopButton.frame))

        editor.layoutStatus = .preFocusText
        editor.layoutIfNeeded()
        assertAttachmentEntryIsHittable(editor)
        XCTAssertFalse(editor.moreButton.frame.intersects(editor.stopButton.frame))
    }

    @MainActor
    private func assertAttachmentEntryIsHittable(_ editor: InputEditor, file: StaticString = #filePath, line: UInt = #line) {
        let button = editor.moreButton
        XCTAssertEqual(button.alpha, 1, file: file, line: line)
        XCTAssertTrue(editor.bounds.contains(button.frame), "Button \(button.frame), editor \(editor.bounds)", file: file, line: line)
        XCTAssertEqual(button.frame.size, editor.iconSize, file: file, line: line)
        XCTAssertFalse(button.frame.intersects(editor.textView.frame), file: file, line: line)
        XCTAssertNotNil(editor.elementClipper.hitTest(button.center, with: nil), file: file, line: line)
        let hit = editor.elementClipper.hitTest(button.center, with: nil)
        XCTAssertTrue(hit === button || hit?.isDescendant(of: button) == true, "Unexpected hit: \(String(describing: hit))", file: file, line: line)
    }

    @MainActor
    func testOneAttachmentEntryStaysLeadingWhileTextGetsSendSpace() {
        let editor = InputEditor()
        editor.frame = CGRect(x: 0, y: 0, width: 320, height: 64)
        for status in [InputEditor.LayoutStatus.standard, .preFocusText, .editingText] {
            editor.layoutStatus = status
            editor.layoutIfNeeded()
            assertAttachmentEntryIsHittable(editor)
            XCTAssertEqual(editor.moreButton.frame.minX, editor.inset.left)
            XCTAssertGreaterThan(editor.textView.frame.minX, editor.moreButton.frame.maxX)
            XCTAssertGreaterThan(editor.textView.frame.width, 100)
        }
        editor.layoutStatus = .editingText
        editor.layoutIfNeeded()
        XCTAssertEqual(editor.voiceButton.alpha, 0)
        XCTAssertGreaterThan(editor.textView.frame.maxX, editor.voiceButton.frame.minX)
        XCTAssertLessThan(editor.textView.frame.maxX, editor.sendButton.frame.minX)
    }

    @MainActor
    func testAttachmentPanelOffersPhotosCameraAndFilesFromSamePlus() {
        let input = ChatInputView()
        XCTAssertEqual(input.controlPanel.subviews.compactMap(\.accessibilityIdentifier), [
            "composer.attachment.camera", "composer.attachment.photo", "composer.attachment.file",
        ])
        input.refill(withText: "Comment", attachments: [])
        input.inputEditor.moreButton.tapAction()
        XCTAssertTrue(input.controlPanel.isPanelOpen.value)
        XCTAssertEqual(input.inputEditor.textView.text, "Comment")
    }

    @MainActor
    func testPhotoLibraryCancellationPreservesDraftAndAttachments() {
        let input = ChatInputView()
        let attachment = ChatInputAttachment(type: .document, textContent: "existing attachment")
        input.refill(withText: "Unsent draft", attachments: [attachment])
        let picker = PHPickerViewController(configuration: PHPickerConfiguration())

        input.picker(picker, didFinishPicking: [])

        XCTAssertEqual(input.inputEditor.textView.text, "Unsent draft")
        XCTAssertEqual(input.collectObject().attachments, [attachment])
    }

    @MainActor
    func testCameraCancellationPreservesDraftAndAttachments() {
        let input = ChatInputView()
        let attachment = ChatInputAttachment(type: .document, textContent: "existing attachment")
        input.refill(withText: "Unsent draft", attachments: [attachment])

        input.imagePickerControllerDidCancel(UIImagePickerController())

        XCTAssertEqual(input.inputEditor.textView.text, "Unsent draft")
        XCTAssertEqual(input.collectObject().attachments, [attachment])
    }
}
