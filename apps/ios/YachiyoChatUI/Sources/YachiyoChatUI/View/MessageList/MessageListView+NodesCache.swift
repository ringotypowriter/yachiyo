//
//  MessageListView+NodesCache.swift
//  LanguageModelChatUI
//
//  Cache for preprocessed markdown content.
//

import CoreText
import Foundation
import MarkdownParser
import MarkdownView
import UIKit

extension MessageListView {
    /// Preprocessed Markdown per row. A package is reused while the row's content is `==` to the
    /// content it was built from, which short-circuits on shared storage and differing lengths, so
    /// unchanged rows never re-parse or re-highlight. Owned by the main thread; only
    /// `MarkdownParser.parse` runs elsewhere (see `MessageListView.drainPendingUpdate`).
    @MainActor
    final class MarkdownPackageCache {
        struct Request: Sendable {
            let id: String
            let content: String
            let endsInsideFence: Bool
        }

        struct Parsed: Sendable {
            let request: Request
            let result: MarkdownParser.ParseResult
        }

        private struct Record {
            let content: String
            let package: MarkdownTextView.PreprocessedContent
        }

        nonisolated let parser = MarkdownParser()
        private var records: [String: Record] = [:]

        var count: Int { records.count }

        func package(
            for id: String,
            content: String,
            endsInsideFence: Bool = false,
            theme: MarkdownTheme
        ) -> MarkdownTextView.PreprocessedContent {
            if let record = records[id], record.content == content { return record.package }
            let request = Request(id: id, content: content, endsInsideFence: endsInsideFence)
            return store(Parsed(request: request, result: parser.parse(content)), theme: theme)
        }

        func missingRequests(in entries: [Entry]) -> [Request] {
            entries.compactMap { entry in
                guard case let .responseContent(_, chunk) = entry else { return nil }
                if let record = records[entry.id], record.content == chunk.content { return nil }
                return Request(id: entry.id, content: chunk.content, endsInsideFence: chunk.endsInsideFence)
            }
        }

        @discardableResult
        func store(_ parsed: Parsed, theme: MarkdownTheme) -> MarkdownTextView.PreprocessedContent {
            let request = parsed.request
            let isGrowing = records[request.id].map { previous in
                request.content.utf8.count > previous.content.utf8.count
                    && request.content.utf8.starts(with: previous.content.utf8)
            } ?? false
            // A still-open trailing fence would miss the content-keyed highlight cache on every
            // delta; it renders plain until its closing fence arrives.
            let package = Self.makePackage(
                parsed.result,
                theme: theme,
                skipsTrailingCodeHighlight: request.endsInsideFence && isGrowing
            )
            records[request.id] = Record(content: request.content, package: package)
            return package
        }

        func prune(keeping ids: Set<String>) {
            records = records.filter { ids.contains($0.key) }
        }

        func removeAll() {
            records.removeAll()
        }

        /// `PreprocessedContent(parserResult:theme:)` with the trailing code block optionally left
        /// unhighlighted. A missing highlight map renders a code block as plain text.
        static func makePackage(
            _ result: MarkdownParser.ParseResult,
            theme: MarkdownTheme,
            skipsTrailingCodeHighlight: Bool
        ) -> MarkdownTextView.PreprocessedContent {
            var codeBlocks: [(language: String?, content: String)] = []
            collectCodeBlocks(in: result.document, into: &codeBlocks)
            if skipsTrailingCodeHighlight, !codeBlocks.isEmpty { codeBlocks.removeLast() }
            let highlighter = CodeHighlighter.current
            var highlightMaps: [Int: CodeHighlighter.HighlightMap] = [:]
            for block in codeBlocks {
                let key = highlighter.key(for: block.content, language: block.language)
                guard highlightMaps[key] == nil else { continue }
                highlightMaps[key] = highlighter.highlight(key: key, content: block.content, language: block.language)
            }
            let rendered: RenderedTextContent.Map = result.render(theme: theme)
            return .init(blocks: result.document, rendered: rendered, highlightMaps: highlightMaps)
        }

        /// Code blocks in document order, so the last one is the block an open fence belongs to.
        private static func collectCodeBlocks(
            in nodes: [MarkdownBlockNode],
            into blocks: inout [(language: String?, content: String)]
        ) {
            for node in nodes {
                switch node {
                case let .codeBlock(language, content):
                    blocks.append((language, content))
                case let .blockquote(children):
                    collectCodeBlocks(in: children, into: &blocks)
                case let .bulletedList(_, items), let .numberedList(_, _, items):
                    for item in items { collectCodeBlocks(in: item.children, into: &blocks) }
                case let .taskList(_, items):
                    for item in items { collectCodeBlocks(in: item.children, into: &blocks) }
                case .paragraph, .heading, .table, .thematicBreak:
                    break
                }
            }
        }
    }
}

// MARK: - Spacing between chunks

extension MessageListView {
    /// The top-level block kinds whose paragraph styles decide the space between two chunks.
    enum BlockKind: Hashable {
        case paragraph, heading, bulletedList, numberedList, taskList, codeBlock, blockquote, table, thematicBreak

        init(_ node: MarkdownBlockNode?) {
            switch node {
            case .heading: self = .heading
            case .bulletedList: self = .bulletedList
            case .numberedList: self = .numberedList
            case .taskList: self = .taskList
            case .codeBlock: self = .codeBlock
            case .blockquote: self = .blockquote
            case .table: self = .table
            case .thematicBreak: self = .thematicBreak
            case .paragraph, nil: self = .paragraph
            }
        }

        /// A minimal document whose first and last line carry this kind's paragraph style.
        var sample: String {
            switch self {
            case .paragraph: "a"
            case .heading: "# a"
            case .bulletedList: "- a"
            case .numberedList: "1. a"
            case .taskList: "- [ ] a"
            case .codeBlock: "```\na\n```"
            case .blockquote: "> a"
            case .table: "| a |\n| - |\n| a |"
            case .thematicBreak: "---"
            }
        }
    }

    /// Measures, once per theme and pair of block kinds, the space MarkdownView renders between
    /// two top-level blocks: height(A + B) − height(A) − height(B), in unrounded CoreText points.
    /// Content does not matter: the gap comes from the paragraph spacing of A's last line and B's
    /// first line (a chunk never starts with a list item, so the samples never merge into one list).
    @MainActor
    final class ChunkSpacingCache {
        private struct Pair: Hashable {
            let after: BlockKind
            let before: BlockKind
        }

        private var values: [Pair: CGFloat] = [:]
        private let parser = MarkdownParser()
        private lazy var view = MarkdownTextView()

        func removeAll() {
            values.removeAll()
        }

        func spacing(after: BlockKind, before: BlockKind, theme: MarkdownTheme) -> CGFloat {
            let pair = Pair(after: after, before: before)
            if let value = values[pair] { return value }
            if view.theme != theme { view.theme = theme }
            let value = height(of: after.sample + "\n\n" + before.sample, theme: theme)
                - height(of: after.sample, theme: theme)
                - height(of: before.sample, theme: theme)
            values[pair] = value
            return value
        }

        private func height(of markdown: String, theme: MarkdownTheme) -> CGFloat {
            view.setMarkdownManually(.init(parserResult: parser.parse(markdown), theme: theme))
            let framesetter = CTFramesetterCreateWithAttributedString(view.textView.attributedText)
            return CTFramesetterSuggestFrameSizeWithConstraints(
                framesetter,
                CFRange(location: 0, length: 0),
                nil,
                CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude),
                nil
            ).height
        }
    }
}
