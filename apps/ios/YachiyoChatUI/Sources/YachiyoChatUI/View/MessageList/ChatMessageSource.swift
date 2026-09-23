//
//  ChatMessageSource.swift
//  YachiyoChatUI
//
//  Replaces LanguageModelChatUI's ConversationSession as the list's data source, so the view
//  layer renders whatever the remote thread store publishes instead of running inference.
//

import Combine
import Foundation

@MainActor
public protocol ChatMessageSource: AnyObject {
    var messages: [ConversationMessage] { get }
    /// Every change to `messages`; the flag asks the list to follow the newest content.
    var messagesDidChange: AnyPublisher<([ConversationMessage], Bool), Never> { get }
    /// Fires when the user sends, so the list jumps back to the bottom.
    var userDidSendMessage: AnyPublisher<Void, Never> { get }
    func message(for id: String) -> ConversationMessage?
    func notifyMessagesDidChange(scrolling: Bool)
}
