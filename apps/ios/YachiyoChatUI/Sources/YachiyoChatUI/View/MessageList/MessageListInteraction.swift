//
//  MessageListInteraction.swift
//  YachiyoChatUI
//
//  Callbacks for the Yachiyo-specific rows (questions, plans, branches) and message menus.
//

import UIKit

public enum PlanCardAction: Sendable {
    /// Focus the composer; a message sent while the plan is pending revises it.
    case requestChanges
    case accept
    case acceptAndHandoff
    case open
}

@MainActor
public protocol MessageListInteractionDelegate: AnyObject {
    func messageList(_ list: MessageListView, answer: String, toQuestion question: QuestionContentPart)
    func messageList(_ list: MessageListView, plan messageId: String, action: PlanCardAction)
    func messageList(_ list: MessageListView, showSiblingOf messageId: String, offset: Int)
    func messageList(_ list: MessageListView, didSelectToolCall toolCallId: String)
    func messageList(_ list: MessageListView, menuForMessage messageId: String, role: MessageRole) -> UIMenu?
    func messageList(_ list: MessageListView, didChangeFollowingBottom isFollowing: Bool)
}

public extension MessageListInteractionDelegate {
    func messageList(_: MessageListView, didSelectToolCall _: String) {}
    func messageList(_: MessageListView, menuForMessage _: String, role _: MessageRole) -> UIMenu? { nil }
    func messageList(_: MessageListView, didChangeFollowingBottom _: Bool) {}
}
