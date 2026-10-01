import Litext
import MarkdownParser
import MarkdownView
import UIKit
import XCTest
@testable import YachiyoChatUI

/// A text selection keeps covering the characters the reader chose while the row's text is
/// replaced; when that is no longer possible it ends instead of moving onto other characters.
@MainActor
final class TextSelectionTests: XCTestCase {
    private func range(of substring: String, in text: String) -> NSRange {
        (text as NSString).range(of: substring)
    }

    func testAnchorHoldsWhileOnlyTextAfterItChanges() throws {
        let text = "你好 👨‍👩‍👧 👋🏽 world"
        for selected in ["你好", "👨‍👩‍👧", "👋🏽"] {
            let anchor = try XCTUnwrap(TextSelectionAnchor(range: range(of: selected, in: text), in: text))
            XCTAssertTrue(anchor.holds(in: text + " and more tokens"))
            XCTAssertFalse(anchor.holds(in: "您" + text.dropFirst()), selected)
        }
        let family = try XCTUnwrap(TextSelectionAnchor(range: range(of: "👨‍👩‍👧", in: text), in: text))
        XCTAssertFalse(family.holds(in: text.replacingOccurrences(of: "👨‍👩‍👧", with: "👨‍👩‍👦")))
        XCTAssertFalse(family.holds(in: "你好"), "the text no longer reaches the selection's end")
        XCTAssertNil(TextSelectionAnchor(range: NSRange(location: 2, length: 0), in: text))
    }

    func testCanonicallyEquivalentRewritesEndTheSelection() throws {
        // Swift's String equality treats these as equal, but the selected mark is a different one.
        let before = "a\u{301}\u{328} ok"
        let after = "a\u{328}\u{301} ok"
        XCTAssertEqual(before, after)
        let anchor = try XCTUnwrap(TextSelectionAnchor(range: NSRange(location: 0, length: 2), in: before))
        XCTAssertFalse(anchor.holds(in: after))
    }

    private func makeRow() -> ResponseView {
        let row = ResponseView()
        row.theme = MessageListView.yachiyoMarkdownTheme()
        row.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        return row
    }

    private func show(_ markdown: String, in row: ResponseView) {
        row.show(.init(parserResult: MarkdownParser().parse(markdown), theme: row.theme))
        // Code blocks join the hierarchy when the text draws.
        row.layoutIfNeeded()
        row.markdownView.textView.layoutIfNeeded()
        row.markdownView.textView.layer.displayIfNeeded()
    }

    private func codeLabels(in row: ResponseView) -> [LTXLabel] {
        var labels: [LTXLabel] = []
        var queue: [UIView] = [row.markdownView]
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if let label = view as? LTXLabel, label !== row.markdownView.textView { labels.append(label) }
            queue.append(contentsOf: view.subviews)
        }
        return labels
    }

    func testStreamingKeepsTheSelectionAndAnEarlierRewriteEndsIt() {
        let row = makeRow()
        let label = row.markdownView.textView
        show("Plain **start then bold words", in: row)
        XCTAssertTrue(label.attributedText.string.contains("**"), "unclosed emphasis renders literally")
        label.selectionRange = range(of: "bold", in: label.attributedText.string)

        show("Plain **start then bold words, and more tokens arrive", in: row)
        XCTAssertEqual(label.selectedPlainText(), "bold")

        // Closing the emphasis removes the asterisks before the selection.
        show("Plain **start** then bold words, and more tokens arrive", in: row)
        XCTAssertNil(label.selectionRange)
    }

    func testCodeSelectionFollowsItsBlock() throws {
        let row = makeRow()
        let code = "Intro\n\n```swift\nlet a = 1\n    let b = 2\n```\n"
        show(code, in: row)
        let label = try XCTUnwrap(codeLabels(in: row).first { $0.attributedText.string.contains("let b") })
        label.selectionRange = range(of: "    let b", in: label.attributedText.string)

        show(code + "\nAfter the code.", in: row)
        let selected = codeLabels(in: row).compactMap { $0.selectedPlainText() }
        XCTAssertEqual(selected, ["    let b"], "indentation is copied as shown")

        show("Intro\n\n```swift\nlet z = 0\nlet a = 1\n    let b = 2\n```\n\nAfter the code.", in: row)
        XCTAssertTrue(codeLabels(in: row).allSatisfy { $0.selectionRange == nil })
    }
}
