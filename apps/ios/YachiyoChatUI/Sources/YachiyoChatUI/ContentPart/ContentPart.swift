//
//  ContentPart.swift
//  LanguageModelChatUI
//
//  Inspired by Vercel AI SDK's Parts pattern.
//  Each content block in a message is a typed Part with clear semantics.
//

import Foundation

/// A content block within a message. Messages are composed of one or more parts.
public enum ContentPart: Identifiable, Sendable {
    case text(TextContentPart)
    case image(ImageContentPart)
    case audio(AudioContentPart)
    case file(FileContentPart)
    case reasoning(ReasoningContentPart)
    case toolCall(ToolCallContentPart)
    case toolResult(ToolResultContentPart)
    /// An `askUser` question from the agent (Yachiyo fork).
    case question(QuestionContentPart)

    public var id: String {
        switch self {
        case let .text(part): part.id
        case let .image(part): part.id
        case let .audio(part): part.id
        case let .file(part): part.id
        case let .reasoning(part): part.id
        case let .toolCall(part): part.id
        case let .toolResult(part): part.id
        case let .question(part): part.id
        }
    }
}

// MARK: - Part Types

public struct TextContentPart: Identifiable, Sendable {
    public let id: String
    public var text: String

    public init(id: String = UUID().uuidString, text: String) {
        self.id = id
        self.text = text
    }
}

public struct ImageContentPart: Identifiable, Sendable {
    public let id: String
    public var mediaType: String
    public var data: Data
    public var previewData: Data?
    public var name: String?

    public init(
        id: String = UUID().uuidString,
        mediaType: String,
        data: Data,
        previewData: Data? = nil,
        name: String? = nil
    ) {
        self.id = id
        self.mediaType = mediaType
        self.data = data
        self.previewData = previewData
        self.name = name
    }
}

public struct AudioContentPart: Identifiable, Sendable {
    public let id: String
    public var mediaType: String
    public var data: Data
    public var transcription: String?
    public var name: String?

    public init(
        id: String = UUID().uuidString,
        mediaType: String,
        data: Data,
        transcription: String? = nil,
        name: String? = nil
    ) {
        self.id = id
        self.mediaType = mediaType
        self.data = data
        self.transcription = transcription
        self.name = name
    }
}

public struct FileContentPart: Identifiable, Sendable {
    public let id: String
    public var mediaType: String
    public var data: Data
    public var textContent: String?
    public var name: String?

    public init(
        id: String = UUID().uuidString,
        mediaType: String,
        data: Data,
        textContent: String? = nil,
        name: String? = nil
    ) {
        self.id = id
        self.mediaType = mediaType
        self.data = data
        self.textContent = textContent
        self.name = name
    }
}

public struct ReasoningContentPart: Identifiable, Sendable {
    public let id: String
    public var text: String
    public var duration: TimeInterval
    public var isCollapsed: Bool

    public init(
        id: String = UUID().uuidString,
        text: String,
        duration: TimeInterval = 0,
        isCollapsed: Bool = false
    ) {
        self.id = id
        self.text = text
        self.duration = duration
        self.isCollapsed = isCollapsed
    }
}

/// State of a tool call execution.
public enum ToolCallState: String, Sendable {
    case running
    case succeeded
    case failed
}

public struct ToolCallContentPart: Identifiable, Sendable {
    public let id: String
    public var toolName: String
    public var apiName: String
    public var toolIcon: String?
    public var parameters: String
    public var state: ToolCallState

    public init(
        id: String = UUID().uuidString,
        toolName: String,
        apiName: String = "",
        toolIcon: String? = nil,
        parameters: String = "{}",
        state: ToolCallState = .running
    ) {
        self.id = id
        self.toolName = toolName
        self.apiName = apiName
        self.toolIcon = toolIcon
        self.parameters = parameters
        self.state = state
    }
}

public struct ToolResultContentPart: Identifiable, Sendable {
    public let id: String
    public var toolCallID: String
    public var result: String

    public init(
        id: String = UUID().uuidString,
        toolCallID: String,
        result: String = ""
    ) {
        self.id = id
        self.toolCallID = toolCallID
        self.result = result
    }
}

/// An agent question awaiting (or holding) the user's answer (Yachiyo fork).
public struct QuestionContentPart: Identifiable, Hashable, Sendable {
    /// The askUser tool call id.
    public let id: String
    public var runId: String
    public var question: String
    public var choices: [String]
    public var answer: String?
    public var isWaiting: Bool

    public init(id: String, runId: String, question: String, choices: [String], answer: String?, isWaiting: Bool) {
        self.id = id
        self.runId = runId
        self.question = question
        self.choices = choices
        self.answer = answer
        self.isWaiting = isWaiting
    }
}

/// Message metadata keys the Yachiyo list understands (Yachiyo fork).
public enum MessageMetadataKey {
    /// `pending` or `accepted` on a plan document message.
    public static let plan = "yachiyo.plan"
    /// Sibling position of a message on the current branch, e.g. "2" of "3".
    public static let siblingIndex = "yachiyo.siblingIndex"
    public static let siblingCount = "yachiyo.siblingCount"
    /// A one-line note shown under an assistant message (run stats, "Stopped", errors).
    public static let footer = "yachiyo.footer"
}
