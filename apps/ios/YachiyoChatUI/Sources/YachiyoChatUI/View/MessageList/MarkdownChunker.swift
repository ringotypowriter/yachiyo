//
//  MarkdownChunker.swift
//  YachiyoChatUI
//
//  Splits an assistant reply into groups of top-level Markdown blocks that render exactly as
//  they would inside the whole reply, so a streaming reply re-parses, re-measures and redraws
//  only its tail chunk while finished chunks keep their cached layout.
//

import Foundation

enum MarkdownChunker {
    struct Chunk: Hashable {
        let text: String
        /// The chunk ends inside a fenced code block whose closing fence has not arrived yet.
        let endsInsideFence: Bool
    }

    /// Finished chunks are at least this many UTF-8 bytes, which bounds the per-delta cost of the
    /// tail without turning every paragraph into its own row.
    static let minimumChunkLength = 1024

    /// Splits only at a blank line that is outside fenced code and math, before a line that must
    /// start a new top-level block: unindented, complete, and not a list item (a list item after a
    /// blank line may continue the list above). Messages with link reference definitions or HTML
    /// blocks are never split, because those are resolved across the whole document.
    ///
    /// A split never depends on text after the next block's first line, so earlier chunks keep
    /// identical content while the reply grows, except that a later reference definition, HTML
    /// block or unmatched math opener can merge everything back into one chunk.
    static func split(_ text: String, minimumLength: Int = minimumChunkLength) -> [Chunk] {
        let bytes = Array(text.utf8)
        guard bytes.count > minimumLength else {
            return [Chunk(text: text, endsInsideFence: fenceIsOpen(at: bytes))]
        }

        let lines = lineRanges(in: bytes)
        var inFence = [Bool](repeating: false, count: lines.count)
        var fence: Fence?
        for (index, line) in lines.enumerated() {
            if let open = fence {
                inFence[index] = true
                if isClosingFence(bytes, line, for: open) { fence = nil }
            } else if let open = openingFence(bytes, line) {
                inFence[index] = true
                fence = open
            } else if startsHTMLBlock(bytes, line) || isReferenceDefinition(bytes, line) {
                return [Chunk(text: text, endsInsideFence: false)]
            }
        }
        let endsInsideFence = fence != nil
        let mathBarriers = MathBarriers(text: text, bytes: bytes)

        var chunks: [Chunk] = []
        var chunkStart = 0
        var lastContentEnd: Int?
        var index = 0
        while index < lines.count {
            let line = lines[index]
            guard isBlank(bytes, line), !inFence[index] else {
                lastContentEnd = line.end
                index += 1
                continue
            }
            var next = index
            while next < lines.count, isBlank(bytes, lines[next]), !inFence[next] {
                next += 1
            }
            defer { index = next }
            guard let contentEnd = lastContentEnd, next < lines.count else { continue }
            let start = lines[next]
            guard contentEnd - chunkStart >= minimumLength,
                  start.isTerminated,
                  startsTopLevelBlock(bytes, start),
                  mathBarriers.allowsSplit(from: contentEnd, to: start.start)
            else { continue }
            chunks.append(Chunk(text: string(bytes, chunkStart ..< contentEnd), endsInsideFence: false))
            chunkStart = start.start
            lastContentEnd = nil
        }
        guard !chunks.isEmpty else { return [Chunk(text: text, endsInsideFence: endsInsideFence)] }
        chunks.append(Chunk(text: string(bytes, chunkStart ..< bytes.count), endsInsideFence: endsInsideFence))
        return chunks
    }

    // MARK: - Lines

    struct Line {
        let start: Int
        /// Exclusive, before the line feed.
        let end: Int
        let isTerminated: Bool
    }

    private static func lineRanges(in bytes: [UInt8]) -> [Line] {
        var lines: [Line] = []
        var start = 0
        for (offset, byte) in bytes.enumerated() where byte == newline {
            lines.append(Line(start: start, end: offset, isTerminated: true))
            start = offset + 1
        }
        if start < bytes.count { lines.append(Line(start: start, end: bytes.count, isTerminated: false)) }
        return lines
    }

    private static func string(_ bytes: [UInt8], _ range: Range<Int>) -> String {
        String(decoding: bytes[range], as: UTF8.self)
    }

    private static let newline = UInt8(ascii: "\n")
    private static let space = UInt8(ascii: " ")
    private static let tab = UInt8(ascii: "\t")
    private static let carriageReturn = UInt8(ascii: "\r")

    private static func isBlank(_ bytes: [UInt8], _ line: Line) -> Bool {
        bytes[line.start ..< line.end].allSatisfy { $0 == space || $0 == tab || $0 == carriageReturn }
    }

    private static func indentation(_ bytes: [UInt8], _ line: Line) -> Int {
        var width = 0
        for byte in bytes[line.start ..< line.end] {
            if byte == space { width += 1 } else if byte == tab { width += 4 } else { break }
        }
        return width
    }

    private static func firstContentOffset(_ bytes: [UInt8], _ line: Line) -> Int {
        var offset = line.start
        while offset < line.end, bytes[offset] == space || bytes[offset] == tab { offset += 1 }
        return offset
    }

    /// An unindented line that cannot continue a list, an indented code block or a lazy paragraph.
    private static func startsTopLevelBlock(_ bytes: [UInt8], _ line: Line) -> Bool {
        guard line.start < line.end else { return false }
        let first = bytes[line.start]
        guard first != space, first != tab else { return false }
        return !isListItemMarker(bytes, line)
    }

    private static func isListItemMarker(_ bytes: [UInt8], _ line: Line) -> Bool {
        func endsMarker(at offset: Int) -> Bool {
            offset >= line.end || bytes[offset] == space || bytes[offset] == tab || bytes[offset] == carriageReturn
        }
        let first = bytes[line.start]
        if first == UInt8(ascii: "-") || first == UInt8(ascii: "+") || first == UInt8(ascii: "*") {
            return endsMarker(at: line.start + 1)
        }
        var offset = line.start
        while offset < line.end, offset - line.start < 9, (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains(bytes[offset]) {
            offset += 1
        }
        guard offset > line.start, offset < line.end,
              bytes[offset] == UInt8(ascii: ".") || bytes[offset] == UInt8(ascii: ")")
        else { return false }
        return endsMarker(at: offset + 1)
    }

    // MARK: - Document-wide constructs

    private static func startsHTMLBlock(_ bytes: [UInt8], _ line: Line) -> Bool {
        let offset = firstContentOffset(bytes, line)
        guard offset + 1 < line.end, bytes[offset] == UInt8(ascii: "<") else { return false }
        let next = bytes[offset + 1]
        return (UInt8(ascii: "a") ... UInt8(ascii: "z")).contains(next | 0x20)
            || next == UInt8(ascii: "/") || next == UInt8(ascii: "!") || next == UInt8(ascii: "?")
    }

    /// Link reference and footnote definitions, including ones nested in quotes or list items.
    private static func isReferenceDefinition(_ bytes: [UInt8], _ line: Line) -> Bool {
        var offset = line.start
        while offset < line.end, [space, tab, UInt8(ascii: ">")].contains(bytes[offset]) { offset += 1 }
        guard offset < line.end, bytes[offset] == UInt8(ascii: "[") else { return false }
        var cursor = offset + 1
        while cursor + 1 < line.end {
            if bytes[cursor] == UInt8(ascii: "]"), bytes[cursor + 1] == UInt8(ascii: ":") { return true }
            cursor += 1
        }
        return false
    }

    // MARK: - Fences

    struct Fence {
        let marker: UInt8
        let length: Int
        let indentation: Int
    }

    private static func fenceRun(_ bytes: [UInt8], _ line: Line) -> (marker: UInt8, length: Int, end: Int)? {
        let offset = firstContentOffset(bytes, line)
        guard offset < line.end else { return nil }
        let marker = bytes[offset]
        guard marker == UInt8(ascii: "`") || marker == UInt8(ascii: "~") else { return nil }
        var end = offset
        while end < line.end, bytes[end] == marker { end += 1 }
        guard end - offset >= 3 else { return nil }
        return (marker, end - offset, end)
    }

    private static func openingFence(_ bytes: [UInt8], _ line: Line) -> Fence? {
        // Four or more columns is an indented code block (or text inside one), not a fence.
        let indentation = indentation(bytes, line)
        guard indentation <= 3, let run = fenceRun(bytes, line) else { return nil }
        if run.marker == UInt8(ascii: "`"), bytes[run.end ..< line.end].contains(UInt8(ascii: "`")) {
            return nil
        }
        return Fence(marker: run.marker, length: run.length, indentation: indentation)
    }

    private static func isClosingFence(_ bytes: [UInt8], _ line: Line, for fence: Fence) -> Bool {
        guard indentation(bytes, line) <= fence.indentation + 3,
              let run = fenceRun(bytes, line),
              run.marker == fence.marker, run.length >= fence.length
        else { return false }
        return bytes[run.end ..< line.end].allSatisfy { $0 == space || $0 == tab || $0 == carriageReturn }
    }

    private static func fenceIsOpen(at bytes: [UInt8]) -> Bool {
        var fence: Fence?
        for line in lineRanges(in: bytes) {
            if let open = fence {
                if isClosingFence(bytes, line, for: open) { fence = nil }
            } else {
                fence = openingFence(bytes, line)
            }
        }
        return fence != nil
    }
}

// MARK: - Math

extension MarkdownChunker {
    /// MarkdownView substitutes math with document-wide regular expressions before cmark parses
    /// the text, ignoring code fences. A split must not fall inside any of those matches, nor after
    /// an opener whose closing delimiter may still arrive.
    struct MathBarriers {
        /// The same block patterns as MarkdownView 3.9.1's `MarkdownParser.MathContext`. The last
        /// pattern there cannot cross a line break, so it never spans a split.
        private static let expression = try? NSRegularExpression(
            pattern: [
                ###"\$\$([\s\S]*?)\$\$"###,
                ###"\\\\\[([\s\S]*?)\\\\\]"###,
                ###"\\\\\(([\s\S]*?)\\\\\)"###,
                ###"\\\[ ([\s\S]*?) \\\]"###,
                ###"\\\( ([^`\n]*?) \\\)"###,
            ].joined(separator: "|"),
            options: [.caseInsensitive, .allowCommentsAndWhitespace]
        )
        private static let openers: [[UInt8]] = [Array("$$".utf8), Array(#"\\["#.utf8), Array(#"\\("#.utf8), Array(#"\[ "#.utf8)]

        private var spans: [Range<Int>] = []
        private var firstUnmatchedOpener: Int?

        init(text: String, bytes: [UInt8]) {
            guard Self.mayContainMath(bytes) else { return }
            if let expression = Self.expression {
                let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text))
                spans = matches.compactMap { match in
                    guard let range = Range(match.range, in: text) else { return nil }
                    let lower = text.utf8.distance(from: text.startIndex, to: range.lowerBound)
                    return lower ..< lower + text.utf8.distance(from: range.lowerBound, to: range.upperBound)
                }
            }
            var offset = 0
            var spanIndex = 0
            while offset < bytes.count {
                while spanIndex < spans.count, spans[spanIndex].upperBound <= offset { spanIndex += 1 }
                if spanIndex < spans.count, spans[spanIndex].contains(offset) {
                    offset = spans[spanIndex].upperBound
                    continue
                }
                if Self.openers.contains(where: { Self.bytes(bytes, at: offset, match: $0) }) {
                    firstUnmatchedOpener = offset
                    return
                }
                offset += 1
            }
        }

        func allowsSplit(from contentEnd: Int, to nextStart: Int) -> Bool {
            if let firstUnmatchedOpener, firstUnmatchedOpener < nextStart { return false }
            return !spans.contains { $0.lowerBound < nextStart && $0.upperBound > contentEnd }
        }

        private static func mayContainMath(_ bytes: [UInt8]) -> Bool {
            var previous: UInt8 = 0
            for byte in bytes {
                if byte == UInt8(ascii: "$"), previous == UInt8(ascii: "$") { return true }
                if previous == UInt8(ascii: "\\"), byte == UInt8(ascii: "[") || byte == UInt8(ascii: "(") { return true }
                previous = byte
            }
            return false
        }

        private static func bytes(_ bytes: [UInt8], at offset: Int, match pattern: [UInt8]) -> Bool {
            guard offset + pattern.count <= bytes.count else { return false }
            for (index, byte) in pattern.enumerated() where bytes[offset + index] != byte { return false }
            return true
        }
    }
}
