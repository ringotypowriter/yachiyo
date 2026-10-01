import XCTest
@testable import Yachiyo

final class ToolPreviewDocumentTests: XCTestCase {
    private typealias Document = ToolPreviewDocument

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
