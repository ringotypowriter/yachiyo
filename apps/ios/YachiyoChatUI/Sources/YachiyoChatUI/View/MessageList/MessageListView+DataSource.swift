//
//  MessageListView+DataSource.swift
//  LanguageModelChatUI
//
//  Data source types and message-to-entry conversion.
//

import CryptoKit
import Foundation
import MarkdownView

extension MessageListView {
    /// What a user or reasoning row renders. Timestamps stay out: the date hint rows own them, and
    /// a streaming message's timestamp must not reconfigure its rows.
    struct MessageRepresentation: Hashable {
        let id: String
        let role: MessageRole
        let content: String
        var isRevealed: Bool
        var isThinking: Bool
        var thinkingDuration: TimeInterval
    }

    /// One block-aligned slice of an assistant reply (see `MarkdownChunker`). Finished chunks keep
    /// identical content, so their cached package and height survive every later delta.
    struct ResponseChunk: Hashable {
        let messageId: String
        let index: Int
        let content: String
        let endsInsideFence: Bool
        /// The space MarkdownView would render between this chunk's last block and the next chunk's
        /// first block; nil on the reply's last chunk, which keeps the standard row inset.
        var spacingAfter: CGFloat?

        /// Chunk rows split off a reply that is already on screen, so they appear without animation.
        var isContinuation: Bool { index > 0 }
    }

    struct PlanCard: Hashable {
        let messageId: String
        let content: String
        let isPending: Bool
    }

    struct BranchPosition: Hashable {
        let messageId: String
        let index: Int
        let count: Int
    }

    struct Attachments: Hashable {
        let items: [ChatInputAttachment]
    }

    /// Displayable entries for the list view.
    enum Entry: Hashable, Identifiable {
        case userContent(String, MessageRepresentation)
        case userAttachment(String, Attachments)
        case reasoningContent(String, MessageRepresentation)
        case responseContent(String, ResponseChunk)
        case hint(String, String)
        case toolCallHint(String, [ToolCallContentPart], String?, Bool)
        case activityReporting(String)
        case questionCard(String, QuestionContentPart)
        case planCard(String, PlanCard)
        case branchNavigator(String, BranchPosition)

        var id: String {
            switch self {
            case let .userContent(id, _): "user-\(id)"
            case let .userAttachment(id, _): "user-attachment-\(id)"
            case let .reasoningContent(id, _): "reasoning-\(id)"
            case let .responseContent(id, _): "response-\(id)"
            case let .hint(id, _): "hint-\(id)"
            case let .toolCallHint(id, _, _, _): "tool-\(id)"
            case let .activityReporting(msg): "activity-\(msg)"
            case let .questionCard(id, _): "question-\(id)"
            case let .planCard(id, _): "plan-\(id)"
            case let .branchNavigator(id, _): "branch-\(id)"
            }
        }

        static func response(_ chunk: ResponseChunk) -> Entry {
            .responseContent("\(chunk.messageId)-\(chunk.index)", chunk)
        }
    }

    private static let dateHintFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    private static let dayKeyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Convert conversation messages to displayable entries. Response chunks carry no spacing yet;
    /// `annotateChunkSpacing` fills it in once their packages are parsed.
    func entries(from messages: [ConversationMessage]) -> [Entry] {
        var entries: [Entry] = []
        var latestDisplayedDay: Date?

        func checkAddDateHint(_ date: Date) {
            if let latestDisplayedDay, Calendar.current.isDate(date, inSameDayAs: latestDisplayedDay) { return }
            latestDisplayedDay = date
            let hintText = Self.dateHintFormatter.string(from: date)
            let dayKey = Self.dayKeyFormatter.string(from: date)
            entries.append(.hint("date.\(dayKey)", hintText))
        }

        for message in messages {
            checkAddDateHint(message.createdAt)

            let textContent = message.textContent
            let reasoningContent = message.reasoningContent ?? ""
            let isThinking = textContent.isEmpty && !reasoningContent.isEmpty
            var reasoningDuration: TimeInterval = 0
            var reasoningCollapsed = false

            for part in message.parts {
                if case let .reasoning(rp) = part {
                    reasoningDuration = rp.duration
                    reasoningCollapsed = rp.isCollapsed
                }
            }

            if let count = Int(message.metadata[MessageMetadataKey.siblingCount] ?? ""), count > 1 {
                let index = Int(message.metadata[MessageMetadataKey.siblingIndex] ?? "") ?? 0
                entries.append(.branchNavigator(message.id, .init(messageId: message.id, index: index, count: count)))
            }

            switch message.role {
            case .user:
                let attachmentItems = message.parts.enumerated().compactMap { index, part -> ChatInputAttachment? in
                    // Rebuilt messages must keep attachment identity, or every delta reloads the row.
                    func stableID(_ kind: String) -> UUID {
                        UUID(stableName: "attachment/\(message.id)/\(index)/\(kind)")
                    }
                    switch part {
                    case let .image(imagePart):
                        return ChatInputAttachment(
                            id: stableID("image"),
                            type: .image,
                            name: imagePart.name ?? String.localized("Image"),
                            previewImageData: imagePart.previewData ?? imagePart.data,
                            fileData: imagePart.data,
                            storageFilename: imagePart.name ?? "image.jpeg"
                        )
                    case let .audio(audioPart):
                        return ChatInputAttachment(
                            id: stableID("audio"),
                            type: .audio,
                            name: audioPart.name ?? String.localized("Audio"),
                            fileData: audioPart.data,
                            textContent: audioPart.transcription ?? audioPart.name ?? "",
                            storageFilename: audioPart.name ?? "audio.m4a"
                        )
                    case let .file(filePart):
                        return ChatInputAttachment(
                            id: stableID("file"),
                            type: .document,
                            name: filePart.name ?? String.localized("Document"),
                            fileData: filePart.data,
                            textContent: filePart.textContent ?? String(data: filePart.data, encoding: .utf8) ?? "",
                            storageFilename: filePart.name ?? "document.txt"
                        )
                    case .text, .reasoning, .toolCall, .toolResult, .question:
                        return nil
                    }
                }
                if !attachmentItems.isEmpty {
                    entries.append(.userAttachment(message.id, .init(items: attachmentItems)))
                }
                if !textContent.isEmpty {
                    entries.append(.userContent(message.id, MessageRepresentation(
                        id: message.id,
                        role: message.role,
                        content: textContent,
                        isRevealed: !reasoningCollapsed,
                        isThinking: isThinking,
                        thinkingDuration: reasoningDuration
                    )))
                }

            case .assistant:
                // Reasoning
                if !reasoningContent.isEmpty {
                    let reasoningRep = MessageRepresentation(
                        id: message.id,
                        role: message.role,
                        content: reasoningContent,
                        isRevealed: !reasoningCollapsed,
                        isThinking: isThinking,
                        thinkingDuration: reasoningDuration
                    )
                    entries.append(.reasoningContent(message.id, reasoningRep))
                }

                // A stable deck per message preserves selection while calls stream in.
                let toolCalls = message.parts.compactMap { part -> ToolCallContentPart? in
                    if case let .toolCall(call) = part { return call }
                    return nil
                }
                if !toolCalls.isEmpty {
                    let selectedID = selectedToolCalls[message.id].flatMap { id in
                        toolCalls.contains(where: { $0.id == id }) ? id : nil
                    }
                    entries.append(.toolCallHint(message.id, toolCalls, selectedID, expandedToolDecks.contains(message.id)))
                }

                for part in message.parts {
                    if case let .question(question) = part {
                        entries.append(.questionCard(question.id, question))
                    }
                }

                // Text content
                if let planState = message.metadata[MessageMetadataKey.plan] {
                    entries.append(.planCard(message.id, .init(messageId: message.id, content: textContent, isPending: planState == "pending")))
                } else if !textContent.isEmpty {
                    for (index, chunk) in responseChunks(messageID: message.id, text: textContent).enumerated() {
                        entries.append(.response(ResponseChunk(
                            messageId: message.id,
                            index: index,
                            content: chunk.text,
                            endsInsideFence: chunk.endsInsideFence
                        )))
                    }
                }
                if let footer = message.metadata[MessageMetadataKey.footer], !footer.isEmpty {
                    entries.append(.hint("footer.\(message.id)", footer))
                }

            case .system:
                // System messages are not displayed in the list
                break

            default:
                // Custom roles: display as hint
                if !textContent.isEmpty {
                    entries.append(.hint(message.id, textContent))
                }
            }
        }

        return entries
    }

    /// Splitting is linear in the reply, so unchanged replies reuse their previous chunks (and the
    /// chunk strings, which keeps later equality checks on identical storage).
    private func responseChunks(messageID: String, text: String) -> [MarkdownChunker.Chunk] {
        if let cached = responseChunkCache[messageID], cached.text == text { return cached.chunks }
        let chunks = MarkdownChunker.split(text)
        responseChunkCache[messageID] = (text, chunks)
        return chunks
    }

    /// Gives every chunk but a reply's last the spacing MarkdownView renders between its last
    /// block and the next chunk's first block. Requires both chunks' packages to be cached.
    func annotateChunkSpacing(_ entries: inout [Entry]) {
        for index in entries.indices.dropLast() {
            guard case .responseContent(let id, var chunk) = entries[index],
                  case let .responseContent(nextID, next) = entries[index + 1],
                  next.messageId == chunk.messageId
            else { continue }
            let last = markdownPackageCache.package(for: "response-\(id)", content: chunk.content, theme: theme)
            let first = markdownPackageCache.package(for: "response-\(nextID)", content: next.content, theme: theme)
            chunk.spacingAfter = chunkSpacing.spacing(
                after: .init(last.blocks.last),
                before: .init(first.blocks.first),
                theme: theme
            )
            entries[index] = .responseContent(id, chunk)
        }
    }
}

extension UUID {
    /// A name-based (version 5 layout) UUID: the same name always yields the same identifier.
    init(stableName: String) {
        var bytes = Array(Insecure.SHA1.hash(data: Data(stableName.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        self.init(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}

// MARK: - ToolCallContentPart Hashable

extension ToolCallContentPart: Hashable {
    public static func == (lhs: ToolCallContentPart, rhs: ToolCallContentPart) -> Bool {
        lhs.id == rhs.id && lhs.state == rhs.state && lhs.toolName == rhs.toolName
            && lhs.apiName == rhs.apiName && lhs.toolIcon == rhs.toolIcon && lhs.parameters == rhs.parameters
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(state)
        hasher.combine(toolName)
        hasher.combine(apiName)
        hasher.combine(toolIcon)
        hasher.combine(parameters)
    }
}

extension ToolCallState: Hashable {}
