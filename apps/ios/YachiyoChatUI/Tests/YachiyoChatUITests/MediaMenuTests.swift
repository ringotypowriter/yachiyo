import PhotosUI
import UIKit
import XCTest
@testable import YachiyoChatUI

final class MediaMenuTests: XCTestCase {
    @MainActor
    func testImageEntryUsesTapPrimaryNativeMenu() throws {
        let editor = InputEditor()
        let button = editor.bossButton
        XCTAssertTrue(button.showsMenuAsPrimaryAction)
        XCTAssertEqual(button.accessibilityIdentifier, "composer.media")
        XCTAssertNotNil(button.image(for: .normal))
        let menu = try XCTUnwrap(button.menu)
        let actions = menu.children.compactMap { $0 as? UIAction }
        XCTAssertEqual(actions.map(\.identifier.rawValue), ["media.photoLibrary", "media.camera"])
        let photos = try XCTUnwrap(actions.first)
        let camera = try XCTUnwrap(actions.last)
        XCTAssertFalse(photos.attributes.contains(.disabled))
        XCTAssertEqual(camera.attributes.contains(.disabled), !UIImagePickerController.isSourceTypeAvailable(.camera))
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
