//
//  MessageListView+Adapter.swift
//  LanguageModelChatUI
//

import ListViewKit
import Litext
import MarkdownView
import UIKit

private extension MessageListView {
    enum RowType {
        case userContent
        case userAttachment
        case reasoningContent
        case responseContent
        case hint
        case toolCallHint
        case activityReporting
        case questionCard
        case planCard
        case branchNavigator
    }
}

extension MessageListView: ListViewAdapter {
    /// ListViewKit hands over the entry itself; the snapshot fallback copies every entry.
    private func entryForRow(_ item: any Identifiable, at index: Int) -> Entry? {
        (item as? Entry) ?? dataSource.snapshot().item(at: index)
    }

    public func listView(_: ListView, rowKindFor item: any Identifiable, at index: Int) -> any Hashable {
        guard let entry = entryForRow(item, at: index) else { return RowType.hint }
        return switch entry {
        case .userContent: RowType.userContent
        case .userAttachment: RowType.userAttachment
        case .reasoningContent: RowType.reasoningContent
        case .responseContent: RowType.responseContent
        case .hint: RowType.hint
        case .toolCallHint: RowType.toolCallHint
        case .activityReporting: RowType.activityReporting
        case .questionCard: RowType.questionCard
        case .planCard: RowType.planCard
        case .branchNavigator: RowType.branchNavigator
        }
    }

    public func listViewMakeRow(for kind: any Hashable) -> ListRowView {
        guard let type = kind as? RowType else { return .init() }

        let view: MessageListRowView = switch type {
        case .userContent:
            UserMessageView()
        case .userAttachment:
            UserAttachmentView()
        case .reasoningContent:
            ReasoningContentView()
        case .responseContent:
            ResponseView()
        case .hint:
            HintMessageView()
        case .toolCallHint:
            ToolHintView()
        case .activityReporting:
            ActivityReportingView()
        case .questionCard:
            QuestionCardView()
        case .planCard:
            PlanCardView()
        case .branchNavigator:
            BranchNavigatorView()
        }
        view.theme = theme
        return view
    }

    public func listView(_ listView: ListView, heightFor item: any Identifiable, at index: Int) -> CGFloat {
        guard let entry = entryForRow(item, at: index) else { return 0 }
        let containerWidth = max(0, listView.bounds.width - MessageListView.listRowInsets.horizontal)
        if containerWidth == 0 { return 0 }
        let contentHeight = contentHeight(for: entry, width: containerWidth)
        if case let .responseContent(_, chunk) = entry {
            return Self.responseRowHeight(contentHeight: contentHeight, spacingAfter: chunk.spacingAfter)
        }
        return contentHeight + MessageListView.listRowInsets.bottom
    }

    /// A reply's last chunk keeps the standard inset. Earlier chunks add MarkdownView's own block
    /// spacing, rounded to the nearest point (ListViewKit rounds row heights up to whole points),
    /// so the next chunk starts within half a point of where the unsplit reply would draw it.
    static func responseRowHeight(contentHeight: CGFloat, spacingAfter: CGFloat?) -> CGFloat {
        guard let spacingAfter else { return ceil(contentHeight) + listRowInsets.bottom }
        return (contentHeight + spacingAfter).rounded()
    }

    /// Measured content height (row height without the bottom inset), cached across rebuilds.
    func contentHeight(for entry: Entry, width containerWidth: CGFloat) -> CGFloat {
        let category = traitCollection.preferredContentSizeCategory
        if let cached = rowHeightCache.height(for: entry, width: containerWidth, category: category) {
            return cached
        }
        let height = measureContentHeight(for: entry, width: containerWidth)
        rowHeightCache.store(height, for: entry, width: containerWidth, category: category)
        return height
    }

    private func measureContentHeight(for entry: Entry, width containerWidth: CGFloat) -> CGFloat {
        switch entry {
        case let .userContent(_, message):
            let attributedContent = NSAttributedString(string: message.content, attributes: [
                .font: theme.fonts.body,
                .foregroundColor: theme.colors.body,
            ])
            let availableWidth = UserMessageView.availableTextWidth(for: containerWidth)
            return boundingSize(with: availableWidth, for: attributedContent).height + UserMessageView.textPadding * 2
        case .userAttachment:
            return AttachmentsBar.itemHeight
        case let .reasoningContent(_, message):
            guard message.isRevealed else { return ReasoningContentView.unrevealedTileHeight }
            let attributedContent = NSAttributedString(string: message.content, attributes: [
                .font: theme.fonts.footnote,
                .paragraphStyle: ReasoningContentView.paragraphStyle,
            ])
            return boundingSize(with: containerWidth - 16, for: attributedContent).height
                + ReasoningContentView.spacing
                + ReasoningContentView.revealedTileHeight
                + 2
        case let .responseContent(_, chunk):
            if markdownViewForSizeCalculation.theme != theme {
                markdownViewForSizeCalculation.theme = theme
            }
            let package = markdownPackageCache.package(
                for: entry.id, content: chunk.content, endsInsideFence: chunk.endsInsideFence, theme: theme
            )
            markdownViewForSizeCalculation.setMarkdownManually(package)
            // Pixel-rounded by Litext; the row height applies the whole-point rounding.
            return markdownViewForSizeCalculation.boundingSize(for: containerWidth).height
        case .hint:
            return ceil(theme.fonts.footnote.lineHeight + 16)
        case let .activityReporting(content):
            let textHeight = boundingSize(with: .greatestFiniteMagnitude, for: NSAttributedString(string: content, attributes: [
                .font: theme.fonts.body,
            ])).height
            return max(textHeight, ActivityReportingView.loadingSymbolSize.height + 16)
        case let .toolCallHint(_, calls, selectedID, showsAll):
            return ToolHintView.height(width: containerWidth, callCount: calls.count, isExpanded: selectedID != nil, showsAll: showsAll)
        case let .questionCard(_, question):
            return QuestionCardView.height(for: question, width: containerWidth)
        case let .planCard(_, plan):
            return PlanCardView.height(for: plan, width: containerWidth)
        case .branchNavigator:
            return BranchNavigatorView.height
        }
    }

    public func listView(_ listView: ListView, configureRowView rowView: ListRowView, for item: any Identifiable, at index: Int) {
        guard let entry = entryForRow(item, at: index) else { return }

        if let messageRow = rowView as? MessageListRowView {
            // A reconfigure of the same row (e.g. the streaming chunk growing) keeps its selection.
            messageRow.represent(entryID: entry.id)
        }

        if let questionView = rowView as? QuestionCardView {
            if case let .questionCard(_, question) = entry {
                questionView.theme = theme
                questionView.question = question
                if !question.isWaiting { questionDrafts[question.id] = nil }
                questionView.draft = questionDrafts[question.id] ?? ""
                questionView.onDraftChange = { [weak self] draft in
                    self?.questionDrafts[question.id] = draft.isEmpty ? nil : draft
                }
                questionView.onAnswer = { [weak self] answer in
                    guard let self else { return }
                    interactionDelegate?.messageList(self, answer: answer, toQuestion: question)
                }
            }
            return
        }
        if let planView = rowView as? PlanCardView {
            if case let .planCard(_, plan) = entry {
                planView.theme = theme
                planView.plan = plan
                planView.onAction = { [weak self] action in
                    guard let self else { return }
                    interactionDelegate?.messageList(self, plan: plan.messageId, action: action)
                }
            }
            return
        }
        if let branchView = rowView as? BranchNavigatorView {
            if case let .branchNavigator(_, position) = entry {
                branchView.theme = theme
                branchView.position = position
                branchView.onStep = { [weak self] offset in
                    guard let self else { return }
                    interactionDelegate?.messageList(self, showSiblingOf: position.messageId, offset: offset)
                }
            }
            return
        }
        if let messageRow = rowView as? MessageListRowView {
            messageRow.contextMenuProvider = nil
            let menuTarget: (id: String, role: MessageRole)? = switch entry {
            case let .userContent(_, message): (message.id, message.role)
            // Every chunk of a reply offers the menu of the whole message.
            case let .responseContent(_, chunk): (chunk.messageId, .assistant)
            default: nil
            }
            if let menuTarget {
                messageRow.contextMenuProvider = { [weak self] _ in
                    guard let self else { return nil }
                    return interactionDelegate?.messageList(self, menuForMessage: menuTarget.id, role: menuTarget.role)
                }
            }
        }

        if let userMessageView = rowView as? UserMessageView {
            if case let .userContent(_, message) = entry {
                userMessageView.theme = theme
                userMessageView.text = message.content
            }
        } else if let userAttachmentView = rowView as? UserAttachmentView {
            if case let .userAttachment(_, attachments) = entry {
                userAttachmentView.theme = theme
                userAttachmentView.update(with: attachments)
            }
        } else if let responseView = rowView as? ResponseView {
            if case let .responseContent(_, chunk) = entry {
                responseView.theme = theme
                let messageID = chunk.messageId
                responseView.linkTapHandler = { [weak self] payload, _, _ in
                    guard let self else { return }
                    let destination: String
                    switch payload {
                    case let .url(url): destination = url.absoluteString
                    case let .string(string): destination = string
                    }
                    interactionDelegate?.messageList(self, openLink: destination, messageId: messageID)
                }
                let containerWidth = max(0, listView.bounds.width - MessageListView.listRowInsets.horizontal)
                if containerWidth > 0 {
                    // The content view hugs the measured text; the rest of the row is the gap.
                    let height = contentHeight(for: entry, width: containerWidth)
                    responseView.rowBottomInset = Self.responseRowHeight(contentHeight: height, spacingAfter: chunk.spacingAfter) - height
                }
                let package = markdownPackageCache.package(
                    for: entry.id, content: chunk.content, endsInsideFence: chunk.endsInsideFence, theme: theme
                )
                if responseView.markdownView.document !== package {
                    responseView.markdownView.setMarkdown(package)
                }
            }
        } else if let hintMessageView = rowView as? HintMessageView {
            if case let .hint(_, content) = entry {
                hintMessageView.theme = theme
                hintMessageView.text = content
            }
        } else if let activityReportingView = rowView as? ActivityReportingView {
            if case let .activityReporting(content) = entry {
                activityReportingView.theme = theme
                activityReportingView.text = content
            }
        } else if let reasoningContentView = rowView as? ReasoningContentView {
            if case let .reasoningContent(_, message) = entry {
                reasoningContentView.theme = theme
                reasoningContentView.isRevealed = message.isRevealed
                reasoningContentView.isThinking = message.isThinking
                reasoningContentView.thinkingDuration = message.thinkingDuration
                reasoningContentView.text = message.content
                reasoningContentView.thinkingTileTapHandler = { [weak self] _ in
                    guard let self, let conversationMessage = session?.message(for: message.id) else { return }
                    for (index, part) in conversationMessage.parts.enumerated() {
                        if case var .reasoning(reasoningPart) = part {
                            reasoningPart.isCollapsed.toggle()
                            conversationMessage.parts[index] = .reasoning(reasoningPart)
                            break
                        }
                    }
                    session?.notifyMessagesDidChange(scrolling: false)
                }
            }
        } else if let toolHintView = rowView as? ToolHintView {
            if case let .toolCallHint(messageID, calls, selectedID, showsAll) = entry {
                toolHintView.theme = theme
                toolHintView.configure(calls: calls, selectedID: selectedID, showsAll: showsAll)
                toolHintView.onSelect = { [weak self] selectedID in
                    guard let self else { return }
                    selectedToolCalls[messageID] = selectedID
                    session?.notifyMessagesDidChange(scrolling: false)
                }
                toolHintView.onDetails = { [weak self] toolCallID in
                    guard let self else { return }
                    interactionDelegate?.messageList(self, didSelectToolCall: toolCallID)
                }
                toolHintView.onToggleAll = { [weak self] in
                    guard let self else { return }
                    if expandedToolDecks.contains(messageID) {
                        expandedToolDecks.remove(messageID)
                        selectedToolCalls[messageID] = nil
                    } else {
                        expandedToolDecks.insert(messageID)
                    }
                    session?.notifyMessagesDidChange(scrolling: false)
                }
            }
        }
    }

    private func boundingSize(with width: CGFloat, for attributedString: NSAttributedString) -> CGSize {
        labelForSizeCalculation.preferredMaxLayoutWidth = width
        labelForSizeCalculation.attributedText = attributedString
        let contentSize = labelForSizeCalculation.intrinsicContentSize
        return .init(width: ceil(contentSize.width), height: ceil(contentSize.height))
    }
}
