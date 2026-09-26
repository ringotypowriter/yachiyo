import ListViewKit
import MarkdownParser
import MarkdownView
import UIKit
import XCTest
@testable import YachiyoChatUI

/// Chunked replies must render exactly like the unsplit reply: the same text, fonts and paragraph
/// styles, and chunk rows stacked where the unsplit document would place each block.
@MainActor
final class ChunkedResponseRenderingTests: XCTestCase {
    private static let documents: [String] = [
        """
        # Streaming plan

        We render **incrementally**, so only the *tail* changes. Links like [Yachiyo](https://example.com) and `inline code` stay intact.

        ## Steps

        1. Parse the reply
        2. Split it

        3. Measure the tail

        - bullet one
          - nested bullet
        - bullet two

        - [ ] open task
        - [x] done task

        ```swift
        struct Chunk {
            let text: String

            let index: Int
        }
        ```

        > A quote that spans
        > two lines.

        | Step | Cost |
        | ---- | ---: |
        | parse | O(n) |
        | measure | O(tail) |

        ---

        Setext heading
        ==============

        Block math:

        $$
        E = mc^2
        $$

        中文段落，包含标点。最后一段。
        """,
        """
        Short intro.

        ```
        unterminated code block

        still code
        """,
        """
        Quote first

        > quoted

        Paragraph after a quote.

        ### Heading after a paragraph

        ```json
        {"a": 1}
        ```

        | a |
        | - |
        | b |

        Paragraph after a table.
        """,
    ]

    private let width: CGFloat = 350

    func testChunksRenderTheSameTextAndStylesAsTheWholeReply() {
        let theme = MessageListView.yachiyoMarkdownTheme()
        for document in Self.documents {
            let chunks = MarkdownChunker.split(document, minimumLength: 1)
            XCTAssertGreaterThan(chunks.count, 1)
            let whole = signature(of: renderedRuns(of: document, theme: theme))
            let joined = signature(of: chunks.flatMap { renderedRuns(of: $0.text, theme: theme) })
            XCTAssertEqual(joined, whole)
        }
    }

    func testSignatureDetectsASplitThatWouldChangeRendering() {
        // Splitting a loose list between items would end the list and change its spacing.
        let theme = MessageListView.yachiyoMarkdownTheme()
        let whole = signature(of: renderedRuns(of: "1. one\n\n2. two", theme: theme))
        let naive = signature(of: renderedRuns(of: "1. one", theme: theme) + renderedRuns(of: "2. two", theme: theme))
        XCTAssertNotEqual(naive, whole)
    }

    func testChunkRowsStackToTheWholeReplyHeight() {
        for document in Self.documents {
            let list = MessageListView()
            list.applyYachiyoTheme()
            list.frame = CGRect(x: 0, y: 0, width: width + MessageListView.listRowInsets.horizontal, height: 800)
            list.layoutIfNeeded()
            var entries = MarkdownChunker.split(document, minimumLength: 1).enumerated().map { index, chunk in
                MessageListView.Entry.response(.init(messageId: "reply", index: index, content: chunk.text, endsInsideFence: chunk.endsInsideFence))
            }
            list.annotateChunkSpacing(&entries)

            var exactTop: CGFloat = 0
            var rowTop: CGFloat = 0
            for (index, entry) in entries.enumerated() {
                guard case let .responseContent(_, chunk) = entry else { return XCTFail("Expected response chunks") }
                let height = list.contentHeight(for: entry, width: width)
                if index < entries.count - 1 {
                    XCTAssertNotNil(chunk.spacingAfter)
                    exactTop += height + (chunk.spacingAfter ?? 0)
                    rowTop += ceil(MessageListView.responseRowHeight(contentHeight: height, spacingAfter: chunk.spacingAfter))
                } else {
                    XCTAssertNil(chunk.spacingAfter)
                    exactTop += height
                    rowTop += height
                }
            }
            let whole = wholeHeight(of: document, theme: list.markdownTheme)
            // CoreText lays lines out on whole points, so chunk rows stack to the unsplit height;
            // the tolerance only absorbs pixel rounding of the measured heights.
            XCTAssertEqual(exactTop, whole, accuracy: 1)
            XCTAssertEqual(rowTop, whole, accuracy: 1)
        }
    }

    func testMeasuredSpacingMatchesMarkdownViewParagraphStyles() {
        let list = MessageListView()
        list.applyYachiyoTheme()
        let theme = list.markdownTheme
        let spacing = { (after: MessageListView.BlockKind, before: MessageListView.BlockKind) in
            list.chunkSpacing.spacing(after: after, before: before, theme: theme)
        }
        let paragraphs = spacing(.paragraph, .paragraph)
        XCTAssertGreaterThan(paragraphs, 0)
        // BlockProcessor: every block ends with 16 pt paragraph spacing, a heading adds 16 pt
        // before itself, and a quote's paragraphs use 8 pt. CoreText places lines on whole
        // points, so the last line's font can move the gap by up to a point, which is why the
        // spacing is measured per pair of block kinds instead of assumed.
        XCTAssertEqual(spacing(.codeBlock, .paragraph), paragraphs, accuracy: 1)
        XCTAssertEqual(spacing(.table, .paragraph), paragraphs, accuracy: 1)
        XCTAssertEqual(spacing(.bulletedList, .paragraph), paragraphs, accuracy: 1)
        XCTAssertEqual(spacing(.paragraph, .heading) - paragraphs, 16, accuracy: 1)
        XCTAssertEqual(paragraphs - spacing(.blockquote, .paragraph), 8, accuracy: 1)
    }

    // MARK: - Helpers

    private func renderedView(of markdown: String, theme: MarkdownTheme) -> MarkdownTextView {
        let view = MarkdownTextView()
        view.theme = theme
        view.setMarkdownManually(.init(parserResult: MarkdownParser().parse(markdown), theme: theme))
        return view
    }

    private func wholeHeight(of markdown: String, theme: MarkdownTheme) -> CGFloat {
        renderedView(of: markdown, theme: theme).boundingSize(for: width).height
    }

    /// Text runs with every attribute that affects layout or appearance.
    private func renderedRuns(of markdown: String, theme: MarkdownTheme) -> [(text: String, attributes: String)] {
        let text = renderedView(of: markdown, theme: theme).textView.attributedText
        var runs: [(text: String, attributes: String)] = []
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, range, _ in
            var description = ""
            if let font = attributes[.font] as? UIFont { description += " font=\(font.fontName)@\(font.pointSize)" }
            if let style = attributes[.paragraphStyle] as? NSParagraphStyle {
                description += " para=\(style.paragraphSpacing)/\(style.paragraphSpacingBefore)/\(style.lineSpacing)"
                    + "/\(style.headIndent)/\(style.firstLineHeadIndent)/\(style.tailIndent)/\(style.minimumLineHeight)"
            }
            if let link = attributes[.link] { description += " link=\(link)" }
            if attributes[.underlineStyle] != nil { description += " underline" }
            if attributes[.strikethroughStyle] != nil { description += " strike" }
            if attributes[.backgroundColor] != nil { description += " background" }
            runs.append(((text.string as NSString).substring(with: range), description))
        }
        return runs
    }

    /// Merges adjacent runs with equal attributes, so run boundaries between blocks do not matter.
    private func signature(of runs: [(text: String, attributes: String)]) -> String {
        var merged: [(text: String, attributes: String)] = []
        for run in runs {
            if let last = merged.last, last.attributes == run.attributes {
                merged[merged.count - 1].text += run.text
            } else {
                merged.append(run)
            }
        }
        return merged.map { "[\($0.text)]\($0.attributes)" }.joined(separator: "\n")
    }
}
