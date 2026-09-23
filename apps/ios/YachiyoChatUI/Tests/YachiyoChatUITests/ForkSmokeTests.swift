import XCTest
@testable import YachiyoChatUI

final class ForkSmokeTests: XCTestCase {
    func testConversationMessageTextContentRoundTrips() {
        let message = ConversationMessage(conversationID: "thread", role: .assistant)
        message.textContent = "Hello"
        XCTAssertEqual(message.textContent, "Hello")
    }
}
