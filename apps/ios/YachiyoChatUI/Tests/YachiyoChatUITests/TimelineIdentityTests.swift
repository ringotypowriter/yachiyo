import ListViewKit
import Litext
import MarkdownParser
import MarkdownView
import UIKit
import XCTest
@testable import YachiyoChatUI

/// Rows that did not change must compare equal across rebuilds, and caches must reuse work.
@MainActor
final class TimelineIdentityTests: XCTestCase {
    private func longReply(paragraphs: Int) -> String {
        (0 ..< paragraphs).map { index in
            "Paragraph \(index): " + String(repeating: "streamed words that fill the line. ", count: 12)
        }.joined(separator: "\n\n")
    }

    private func responseChunks(_ entries: [MessageListView.Entry]) -> [MessageListView.ResponseChunk] {
        entries.compactMap { entry in
            guard case let .responseContent(_, chunk) = entry else { return nil }
            return chunk
        }
    }

    func testStreamingReplyKeepsFinishedChunkEntriesIdentical() {
        let list = MessageListView()
        let message = ConversationMessage(id: "reply", conversationID: "thread", role: .assistant)
        let text = longReply(paragraphs: 12)
        message.textContent = String(text.prefix(text.count / 2))
        let before = list.entries(from: [message])
        message.textContent = text
        let after = list.entries(from: [message])

        let beforeChunks = responseChunks(before)
        let afterChunks = responseChunks(after)
        XCTAssertGreaterThan(beforeChunks.count, 1)
        XCTAssertGreaterThan(afterChunks.count, beforeChunks.count)
        XCTAssertEqual(Array(afterChunks.prefix(beforeChunks.count - 1)), Array(beforeChunks.dropLast()))
        XCTAssertEqual(after.map(\.id).filter { $0.hasPrefix("response-") }, afterChunks.indices.map { "response-reply-\($0)" })
        XCTAssertEqual(afterChunks.map(\.content).joined(separator: "\n\n"), text)
    }

    func testReasoningRowIgnoresAnswerDeltasAndTimestamps() {
        let list = MessageListView()
        func message(answer: String, createdAt: Date) -> ConversationMessage {
            ConversationMessage(id: "m", conversationID: "t", role: .assistant, parts: [
                .reasoning(ReasoningContentPart(id: "m-reasoning", text: "thinking…", isCollapsed: true)),
                .text(TextContentPart(id: "m-text", text: answer)),
            ], createdAt: createdAt)
        }
        func reasoning(_ entries: [MessageListView.Entry]) -> MessageListView.Entry? {
            entries.first { if case .reasoningContent = $0 { return true }; return false }
        }
        let first = reasoning(list.entries(from: [message(answer: "Hello", createdAt: Date(timeIntervalSince1970: 100))]))
        let second = reasoning(list.entries(from: [message(answer: "Hello, world", createdAt: Date(timeIntervalSince1970: 101))]))
        XCTAssertNotNil(first)
        XCTAssertEqual(first, second)
    }

    func testRebuiltAttachmentsKeepTheirIdentity() {
        let list = MessageListView()
        func message() -> ConversationMessage {
            // Part ids minted per rebuild, as the remote store does for files.
            ConversationMessage(id: "sent", conversationID: "t", role: .user, parts: [
                .file(FileContentPart(mediaType: "text/plain", data: Data("notes".utf8), name: "notes.txt")),
                .image(ImageContentPart(mediaType: "image/png", data: Data([1, 2, 3]), name: "a.png")),
            ], createdAt: Date(timeIntervalSince1970: 0))
        }
        let first = list.entries(from: [message()])
        let second = list.entries(from: [message()])
        XCTAssertEqual(first, second)
        guard case let .userAttachment(_, attachments) = first.first(where: { if case .userAttachment = $0 { return true }; return false })
        else { return XCTFail("Expected an attachment row") }
        XCTAssertEqual(Set(attachments.items.map(\.id)).count, 2)
        XCTAssertEqual(UUID(stableName: "x"), UUID(stableName: "x"))
        XCTAssertNotEqual(UUID(stableName: "x"), UUID(stableName: "y"))
        XCTAssertEqual(UUID(stableName: "x").uuidString.dropFirst(14).first, "5")
    }

    func testAttachmentRowUpdateIsANoOpForUnchangedItems() {
        let bar = AttachmentsBar()
        let item = ChatInputAttachment(id: UUID(stableName: "a"), type: .document, name: "a.txt", textContent: "a")
        XCTAssertTrue(bar.replaceItems(with: [item]))
        XCTAssertFalse(bar.replaceItems(with: [item]))
        var edited = item
        edited.textContent = "b"
        XCTAssertTrue(bar.replaceItems(with: [edited]))
        XCTAssertEqual(bar.attachments.values.first?.textContent, "b")
    }

    func testPackageCacheReusesEqualContentAndSkipsOpenFenceHighlightWhileGrowing() {
        let cache = MessageListView.MarkdownPackageCache()
        let theme = MessageListView.yachiyoMarkdownTheme()
        let text = "Intro\n\n```swift\nlet a = 1"
        let first = cache.package(for: "row", content: text, endsInsideFence: true, theme: theme)
        XCTAssertTrue(first === cache.package(for: "row", content: String(text), endsInsideFence: true, theme: theme))

        func codeKey(_ package: MarkdownTextView.PreprocessedContent) -> Int? {
            for block in package.blocks {
                if case let .codeBlock(language, content) = block {
                    return CodeHighlighter.current.key(for: content, language: language)
                }
            }
            return nil
        }
        // First sight is highlighted; later deltas of the still-open fence render plain.
        XCTAssertNotNil(codeKey(first).flatMap { first.highlightMaps[$0] })
        let grown = cache.package(for: "row", content: text + "\nlet b = 2", endsInsideFence: true, theme: theme)
        XCTAssertFalse(grown === first)
        XCTAssertNil(codeKey(grown).flatMap { grown.highlightMaps[$0] })
        let closed = cache.package(for: "row", content: text + "\nlet b = 2\n```", endsInsideFence: false, theme: theme)
        XCTAssertNotNil(codeKey(closed).flatMap { closed.highlightMaps[$0] })
    }

    func testMissingRequestsListOnlyChangedChunks() {
        let list = MessageListView()
        let message = ConversationMessage(id: "reply", conversationID: "thread", role: .assistant)
        message.textContent = longReply(paragraphs: 8)
        let entries = list.entries(from: [message])
        let requests = list.markdownPackageCache.missingRequests(in: entries)
        XCTAssertEqual(requests.map(\.id), entries.filter { if case .responseContent = $0 { return true }; return false }.map(\.id))
        for request in requests {
            list.markdownPackageCache.store(.init(request: request, result: MarkdownParser().parse(request.content)), theme: list.markdownTheme)
        }
        XCTAssertTrue(list.markdownPackageCache.missingRequests(in: entries).isEmpty)
        message.textContent += " more"
        XCTAssertEqual(list.markdownPackageCache.missingRequests(in: list.entries(from: [message])).count, 1)
    }

    func testHeightCacheSurvivesWidthRoundTripsAndDropsChangedContent() {
        let cache = MessageListView.RowHeightCache()
        let chunk = MessageListView.ResponseChunk(messageId: "m", index: 0, content: "text", endsInsideFence: false)
        let entry = MessageListView.Entry.response(chunk)
        cache.store(100, for: entry, width: 350, category: .large)
        cache.store(80, for: entry, width: 700, category: .large)
        XCTAssertEqual(cache.height(for: entry, width: 350, category: .large), 100)
        XCTAssertEqual(cache.height(for: entry, width: 700, category: .large), 80)
        XCTAssertNil(cache.height(for: entry, width: 350, category: .extraLarge))
        var spaced = chunk
        spaced.spacingAfter = 20
        XCTAssertEqual(cache.height(for: .response(spaced), width: 350, category: .large), 100, "Spacing is not content")
        let changed = MessageListView.Entry.response(.init(messageId: "m", index: 0, content: "text!", endsInsideFence: false))
        XCTAssertNil(cache.height(for: changed, width: 350, category: .large))
        cache.store(120, for: changed, width: 350, category: .large)
        XCTAssertNil(cache.height(for: entry, width: 700, category: .large))
    }

    func testChunkRowsCarrySpacingExceptTheLast() {
        let list = MessageListView()
        list.applyYachiyoTheme()
        let message = ConversationMessage(id: "reply", conversationID: "thread", role: .assistant)
        message.textContent = longReply(paragraphs: 8)
        var entries = list.entries(from: [message])
        list.annotateChunkSpacing(&entries)
        let chunks = responseChunks(entries)
        XCTAssertGreaterThan(chunks.count, 1)
        XCTAssertTrue(chunks.dropLast().allSatisfy { ($0.spacingAfter ?? 0) > 0 })
        XCTAssertNil(chunks.last?.spacingAfter)
    }

    func testToolDeckReusesIconButtonsAcrossConfigures() throws {
        let deck = ToolHintView()
        deck.frame = CGRect(x: 0, y: 0, width: 390, height: 200)
        let running = ToolCallContentPart(id: "a", toolName: "bash")
        deck.configure(calls: [running], selectedID: nil)
        deck.layoutIfNeeded()
        let button = try XCTUnwrap(find("toolDeck.call.a", in: deck) as? UIButton)
        var finished = running
        finished.state = .succeeded
        deck.configure(calls: [finished, ToolCallContentPart(id: "b", toolName: "read")], selectedID: nil)
        deck.layoutIfNeeded()
        XCTAssertTrue(find("toolDeck.call.a", in: deck) === button)
        XCTAssertEqual(button.configuration?.baseForegroundColor, .secondaryLabel)
        XCTAssertNotNil(find("toolDeck.call.b", in: deck))
    }

    func testLoadingSymbolAnimatesOnlyWhileVisibleInAWindow() {
        let symbol = LoadingSymbol(frame: CGRect(x: 0, y: 0, width: 30, height: 10))
        func isAnimating() -> Bool {
            let dot = symbol.layer.sublayers?.first?.sublayers?.first
            return !(dot?.animationKeys() ?? []).isEmpty
        }
        XCTAssertFalse(isAnimating())
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        window.addSubview(symbol)
        XCTAssertTrue(isAnimating())
        symbol.isHidden = true
        XCTAssertFalse(isAnimating())
        symbol.isHidden = false
        XCTAssertTrue(isAnimating())
        symbol.removeFromSuperview()
        XCTAssertFalse(isAnimating())
    }

    func testCollapsedReasoningHidesItsFullText() throws {
        let row = ReasoningContentView()
        row.frame = CGRect(x: 0, y: 0, width: 390, height: ReasoningContentView.unrevealedTileHeight + 16)
        row.text = String(repeating: "long thought ", count: 200)
        row.layoutIfNeeded()
        let fullText = try XCTUnwrap(row.contentView.subviews.first { $0 is Litext.LTXLabel })
        XCTAssertTrue(fullText.isHidden)
        row.isRevealed = true
        row.layoutIfNeeded()
        XCTAssertFalse(fullText.isHidden)
    }

    func testTypingCoalescesDraftPublicationAndFlushesOnDemand() {
        let delegate = CountingDraftDelegate()
        let input = ChatInputView()
        input.delegate = delegate
        input.inputEditor.textView.text = "hello"
        input.onInputEditorTextChanged(text: "h")
        input.onInputEditorTextChanged(text: "he")
        input.onInputEditorTextChanged(text: "hello")
        XCTAssertEqual(delegate.updates.count, 0)
        input.flushScheduledEditorStatus()
        XCTAssertEqual(delegate.updates.map(\.text), ["hello"])
        input.flushScheduledEditorStatus()
        XCTAssertEqual(delegate.updates.count, 1)
    }

    func testThumbnailsDecodeAtDisplaySize() throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 800), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }()).jpegData(withCompressionQuality: 0.8) { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1200, height: 800))
        }
        let thumbnail = try XCTUnwrap(ImageDownsampler.thumbnail(from: source, filling: CGSize(width: 80, height: 80), scale: 3))
        // Aspect fill: the short side covers 240 px without decoding anywhere near 1200 px.
        XCTAssertGreaterThanOrEqual(min(thumbnail.width, thumbnail.height), 239)
        XCTAssertLessThanOrEqual(max(thumbnail.width, thumbnail.height), 361)
        let preview = try XCTUnwrap(ImageDownsampler.previewJPEG(from: source, filling: CGSize(width: 80, height: 80), scale: 3))
        XCTAssertLessThan(preview.count, source.count)
    }

    private func find(_ identifier: String, in root: UIView) -> UIView? {
        if root.accessibilityIdentifier == identifier, !root.isHidden { return root }
        return root.subviews.lazy.compactMap { self.find(identifier, in: $0) }.first
    }
}

@MainActor
private final class CountingDraftDelegate: ChatInputDelegate {
    var updates: [ChatInputContent] = []

    func chatInputDidUpdateObject(_: ChatInputView, object: ChatInputContent) {
        updates.append(object)
    }

    func chatInputDidSubmit(_: ChatInputView, object _: ChatInputContent, completion: @escaping @Sendable (Bool) -> Void) {
        completion(false)
    }
}
