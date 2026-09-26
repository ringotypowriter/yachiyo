import XCTest
@testable import YachiyoChatUI

final class MarkdownChunkerTests: XCTestCase {
    /// Splits `markdown` as a finished reply (with its final line terminated) and returns the
    /// chunks without that added line feed. A split needs the next block's first line complete.
    private func texts(_ markdown: String, minimumLength: Int = 1) -> [String] {
        var chunks = MarkdownChunker.split(markdown + "\n", minimumLength: minimumLength).map(\.text)
        chunks[chunks.count - 1].removeLast()
        return chunks
    }

    func testSplitsTopLevelBlocksAtBlankLinesAndDropsOnlyTheSeparators() {
        let markdown = "# Title\n\nFirst paragraph\nstill first.\n\n```swift\nlet a = 1\n```\n\n> quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nLast"
        let chunks = texts(markdown)
        XCTAssertEqual(chunks, ["# Title", "First paragraph\nstill first.", "```swift\nlet a = 1\n```", "> quote", "| a | b |\n| - | - |\n| 1 | 2 |", "Last"])
        XCTAssertEqual(chunks.joined(separator: "\n\n"), markdown)
    }

    func testShortRepliesAndSmallChunksStayWhole() {
        let markdown = "One\n\nTwo\n\nThree"
        XCTAssertEqual(texts(markdown, minimumLength: 1024), [markdown])
        // Chunks close only after reaching the minimum length.
        XCTAssertEqual(texts("aaaa\n\nb\n\ncccc\n\nd", minimumLength: 4), ["aaaa", "b\n\ncccc", "d"])
    }

    func testNeverSplitsInsideFencedCodeAndReportsAnOpenTrailingFence() {
        let closed = "Intro\n\n```\nline one\n\nline two\n```\n\nAfter"
        XCTAssertEqual(texts(closed), ["Intro", "```\nline one\n\nline two\n```", "After"])

        let tilde = "Intro\n\n~~~~\n```\n\nstill code\n~~~~\n\nAfter"
        XCTAssertEqual(texts(tilde), ["Intro", "~~~~\n```\n\nstill code\n~~~~", "After"])

        let open = MarkdownChunker.split("Intro\n\n```python\nprint(1)\n\nprint(2)", minimumLength: 1)
        XCTAssertEqual(open.map(\.text), ["Intro", "```python\nprint(1)\n\nprint(2)"])
        XCTAssertEqual(open.map(\.endsInsideFence), [false, true])
        XCTAssertTrue(MarkdownChunker.split("```\nshort", minimumLength: 1024)[0].endsInsideFence)
    }

    func testIndentedFenceLikeLinesDoNotToggleFenceState() {
        // "    ```" is indented code, so the real fence below must still protect its blank line.
        let markdown = "Intro\n\n    ```\n\n```\nreal\n\ncode\n```\n\nEnd"
        XCTAssertFalse(texts(markdown).contains { $0.hasPrefix("code") })
    }

    func testListsIndentedContinuationsAndLooseItemsStayTogether() {
        let loose = "Intro\n\n1. one\n\n2. two\n\n- three\n\n* four\n\n+ five\n\n3) six\n\nAfter"
        XCTAssertEqual(texts(loose), ["Intro\n\n1. one\n\n2. two\n\n- three\n\n* four\n\n+ five\n\n3) six", "After"])
        let continuation = "- item\n\n  continued paragraph\n\n      indented code\n\nAfter"
        XCTAssertEqual(texts(continuation), ["- item\n\n  continued paragraph\n\n      indented code", "After"])
        // Thematic breaks are not list items.
        XCTAssertEqual(texts("Text\n\n---\n\nMore"), ["Text", "---", "More"])
    }

    func testDocumentWideConstructsDisableSplitting() {
        for markdown in [
            "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com",
            "Footnote[^1].\n\nMore.\n\n[^1]: The note.",
            "> [ref]: https://example.com\n\nText",
            "Before\n\n<div>\n\n*inside*\n\n</div>\n\nAfter",
            "Before\n\n<!--\n\ncomment\n\n-->\n\nAfter",
        ] {
            XCTAssertEqual(texts(markdown), [markdown], markdown)
        }
        // Fenced code may contain those lines without affecting the reply.
        XCTAssertEqual(texts("A\n\n```html\n<div>\n[x]: y\n```\n\nB").count, 3)
    }

    func testMathSpansAndUnmatchedOpenersBlockSplits() {
        let math = "Intro\n\n$$\na = b\n\nc = d\n$$\n\nAfter"
        XCTAssertEqual(texts(math), ["Intro", "$$\na = b\n\nc = d\n$$", "After"])
        let bracket = "Intro\n\n\\[ x\n\ny \\]\n\nAfter"
        XCTAssertEqual(texts(bracket), ["Intro", "\\[ x\n\ny \\]", "After"])
        // MarkdownView pairs `$$` across code fences, so the reply must not split between them.
        let crossing = "`$$`\n\n```\necho $$\n```\n\nEnd"
        XCTAssertEqual(texts(crossing), ["`$$`\n\n```\necho $$\n```", "End"])
        // A closing delimiter may still arrive: nothing after an unmatched opener splits.
        XCTAssertEqual(texts("A\n\n$$ x\n\nB\n\nC"), ["A", "$$ x\n\nB\n\nC"])
    }

    func testIncompleteNextLineWaitsBeforeSplitting() {
        // "1" could still become "1. item", which would continue the list above.
        func raw(_ markdown: String) -> [String] { MarkdownChunker.split(markdown, minimumLength: 1).map(\.text) }
        XCTAssertEqual(raw("- item\n\n1"), ["- item\n\n1"])
        XCTAssertEqual(raw("Para\n\nNext"), ["Para\n\nNext"])
        XCTAssertEqual(raw("Para\n\nNext\n"), ["Para", "Next\n"])
    }

    func testFinishedChunksNeverChangeWhileAReplyStreams() {
        let reply = """
        # Plan

        We will look at **three** parts, each with an example.

        1. Parse the input
        2. Transform it

        3. Render it

        ```swift
        func render() {
            print("hi")

            print("bye")
        }
        ```

        > Note: rendering is incremental.

        | Step | Cost |
        | ---- | ---- |
        | parse | O(n) |

        Math: $$
        E = mc^2
        $$

        Done, 完成。
        """
        let final = MarkdownChunker.split(reply, minimumLength: 16)
        XCTAssertGreaterThan(final.count, 3)
        var index = reply.startIndex
        while index < reply.endIndex {
            index = reply.index(after: index)
            let partial = MarkdownChunker.split(String(reply[..<index]), minimumLength: 16)
            for (chunk, finalChunk) in zip(partial.dropLast(), final) {
                XCTAssertEqual(chunk, finalChunk, "prefix length \(reply.distance(from: reply.startIndex, to: index))")
            }
        }
    }
}
