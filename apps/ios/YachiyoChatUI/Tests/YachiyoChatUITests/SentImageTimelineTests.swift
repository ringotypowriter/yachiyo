import UIKit
import XCTest
@testable import YachiyoChatUI

final class SentImageTimelineTests: XCTestCase {
    @MainActor
    func testSentImagePartBecomesPreviewableTimelineAttachment() {
        let image = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlE5X8AAAAASUVORK5CYII=")!
        let message = ConversationMessage(id: "sent", conversationID: "thread", role: .user, parts: [
            .image(ImageContentPart(id: "sent-image-0", mediaType: "image/png", data: image, name: "photo.png")),
        ])
        let list = MessageListView()
        guard let attachment = list.entries(from: [message]).first(where: {
            if case .userAttachment = $0 { return true }
            return false
        }), case let .userAttachment(_, attachments) = attachment else {
            return XCTFail("Sent image should be an attachment row")
        }
        XCTAssertEqual(attachments.items.count, 1)
        XCTAssertEqual(attachments.items[0].type, .image)
        XCTAssertEqual(attachments.items[0].fileData, image)
        XCTAssertNotNil(UIImage(data: attachments.items[0].previewImageData))
    }
}
