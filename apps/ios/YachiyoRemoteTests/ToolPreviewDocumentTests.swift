import XCTest
import UIKit
import YachiyoRemoteKit
@testable import Yachiyo

final class ToolPreviewDocumentTests: XCTestCase {
    private typealias Document = ToolPreviewDocument

    @MainActor
    func testNativeSheetWrapsAndHighlightsCommandWithoutChangingSelectableText() async throws {
        let id = UUID().uuidString
        let command = "python3 - <<'EOF'\nimport json\npath = '/tmp/" + String(repeating: "long-directory/", count: 10) + "report.json'\nprint(path)\nEOF"
        let input = try JSONSerialization.data(withJSONObject: ["description": "Inspect the cached report and print its location", "command": command])
        let payload: [String: Any] = [
            "type": "tool.updated", "threadId": id, "summaryOnly": true,
            "toolCall": ["id": id, "toolName": "bash", "title": "Inspect report", "status": "completed", "startedAt": "2026-10-13T09:00:00Z", "truncated": false,
                         "inputPreview": String(decoding: input, as: UTF8.self), "outputPreview": "Report found"],
        ]
        let event = try JSONDecoder().decode(RemoteEvent.self, from: JSONSerialization.data(withJSONObject: payload))
        let thread = ThreadStore(desktopId: id, threadId: id)
        await thread.open()
        defer { thread.close() }
        RemoteStore.shared.threadEvents.send((desktopId: id, event: event, seq: 1))
        let controller = ToolPreviewViewController(thread: thread, toolCallId: id)
        let navigation = UINavigationController(rootViewController: controller)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = navigation
        window.isHidden = false
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        controller.view.layoutIfNeeded()
        let reader = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UITextView }.first)
        XCTAssertFalse(reader.isEditable)
        XCTAssertTrue(reader.isSelectable)
        XCTAssertTrue(reader.text.contains(command))
        XCTAssertEqual(controller.navigationItem.leftBarButtonItem?.accessibilityIdentifier, "toolPreview.close")
        XCTAssertEqual(controller.navigationItem.rightBarButtonItem?.accessibilityIdentifier, "toolPreview.refresh")
        let range = (reader.text as NSString).range(of: command)
        var colors = Set<String>()
        reader.attributedText.enumerateAttribute(.foregroundColor, in: range) { value, _, _ in
            if let color = value as? UIColor { colors.insert(color.description) }
        }
        XCTAssertGreaterThan(colors.count, 1)
        for (name, width, appearance) in [("light", 390.0, UIUserInterfaceStyle.light), ("dark-narrow", 320.0, .dark)] {
            window.frame.size.width = width
            window.overrideUserInterfaceStyle = appearance
            window.layoutIfNeeded()
            reader.layoutManager.ensureLayout(for: reader.textContainer)
            XCTAssertLessThanOrEqual(reader.contentSize.width, reader.bounds.width + 1)
            let glyphs = reader.layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let bounds = reader.layoutManager.boundingRect(forGlyphRange: glyphs, in: reader.textContainer)
            XCTAssertGreaterThan(bounds.height, 120)
            let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
                window.layer.render(in: context.cgContext)
            }
            let attachment = XCTAttachment(image: screenshot)
            attachment.name = "tool-sheet-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testBashInputSeparatesDescriptionAndUnescapedCommandWithoutLosingOptions() {
        let sections = Document.inputSections(
            input: #"{"command":"echo \"hello\"\nprintf '世界'","description":"Print a greeting","timeout":30,"background":false}"#,
            title: "Fallback title", toolName: "bash"
        )
        XCTAssertEqual(sections.map(\.heading), ["Description", "Command", "Background", "Timeout"])
        XCTAssertEqual(sections.map(\.body), ["Print a greeting", "echo \"hello\"\nprintf '世界'", "false", "30"])
        XCTAssertEqual(sections[1].language, "bash")
    }

    func testCodeArgumentsKeepTheirLanguageAndNestedValues() {
        let sections = Document.inputSections(input: #"{"code":"print('ok')","options":{"items":[1,2]}}"#, title: "Run Python", toolName: "pyRepl")
        XCTAssertEqual(sections[1].language, "python")
        XCTAssertEqual(sections[1].body, "print('ok')")
        XCTAssertEqual(sections[2].language, "json")
        XCTAssertTrue(sections[2].body.contains("items"))
    }

    func testMalformedOrTruncatedInputIsPreservedVerbatim() {
        let input = "{\"command\":\"partial"
        let sections = Document.inputSections(input: input, title: "Run command", toolName: "bash")
        XCTAssertEqual(sections.map(\.body), ["Run command", input])
        XCTAssertEqual(sections.last?.heading, "Input")
        XCTAssertEqual(Document.inputSections(input: nil, title: "Run command", toolName: "bash").count, 1)
    }

    func testParameterSelectionSurvivesOtherParametersBeingInserted() {
        let before = Document(sections: Document.inputSections(input: #"{"path":"/tmp/世界"}"#, title: "Read file", toolName: "read"))
        let after = Document(sections: Document.inputSections(input: #"{"limit":20,"path":"/tmp/世界"}"#, title: "Read file", toolName: "read"))
        let selection = (before.text as NSString).range(of: "/tmp/世界")
        XCTAssertEqual(after.carry(selection: selection, from: before), (after.text as NSString).range(of: "/tmp/世界"))
    }

    private func document(notice: String? = nil, input: String = "ls -la", output: String) -> Document {
        Document(sections: [
            notice.map { Document.Section(key: .notice, heading: nil, body: $0) },
            Document.Section(key: .title, heading: nil, body: "List files"),
            Document.Section(key: .input, heading: "Input", body: input),
            Document.Section(key: .output, heading: "Output", body: output),
        ].compactMap { $0 })
    }

    private func index(of substring: String, in document: Document) -> Int {
        (document.text as NSString).range(of: substring).location
    }

    func testReadingPositionSurvivesANoticeAddedAbove() {
        let before = document(output: "line 1\nline 2\nline 3")
        let after = document(notice: "Couldn't load the preview. Timed out.", output: "line 1\nline 2\nline 3")
        let location = before.location(at: index(of: "line 2", in: before))
        XCTAssertEqual(location, .init(key: .output, offset: 7))
        XCTAssertEqual(after.index(of: location!, after: before), index(of: "line 2", in: after))
    }

    func testPositionInAHeadingMovesToItsBody() {
        let doc = document(output: "result")
        XCTAssertEqual(doc.location(at: index(of: "Output", in: doc)), .init(key: .output, offset: 0))
    }

    func testOffsetsClampToAShorterBodyAndMissingSectionsResolveToTheNextOne() {
        let before = document(notice: "Offline — showing the saved preview.", output: "a much longer output than later")
        let shorter = document(output: "short")
        XCTAssertEqual(shorter.index(of: .init(key: .output, offset: 20), after: before), shorter.bodyRange(of: .output).map(NSMaxRange))
        // The notice is gone: its readers land at the start of the title, which followed it.
        XCTAssertEqual(shorter.index(of: .init(key: .notice, offset: 3), after: before), 0)
    }

    func testSelectionIsKeptWhileItsTextIsUnchanged() {
        let before = document(output: "first line\nsecond line")
        let selected = (before.text as NSString).range(of: "second")
        let grown = document(notice: "Refreshed.", output: "first line\nsecond line\nthird line")
        XCTAssertEqual(grown.carry(selection: selected, from: before), (grown.text as NSString).range(of: "second"))
    }

    func testSelectionEndsWhenTheTextBeforeItChanged() {
        let before = document(output: "first line\nsecond line")
        let selected = (before.text as NSString).range(of: "second")
        XCTAssertNil(document(output: "FIRST line\nsecond line").carry(selection: selected, from: before))
        XCTAssertNil(document(output: "first").carry(selection: selected, from: before))
    }

    func testOffsetsCountUTF16LikeNSRange() {
        let doc = document(output: "👨‍👩‍👧 ok")
        let range = (doc.text as NSString).range(of: "ok")
        XCTAssertEqual(doc.location(at: range.location), .init(key: .output, offset: ("👨‍👩‍👧 " as NSString).length))
        XCTAssertEqual(doc.carry(selection: range, from: doc), range)
    }
}
