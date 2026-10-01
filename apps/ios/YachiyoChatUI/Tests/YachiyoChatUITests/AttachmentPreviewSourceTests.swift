import UIKit
import XCTest
@testable import YachiyoChatUI

/// A preview zooms back to the attachment it shows, wherever that attachment is now, and falls
/// back to the default transition when it is no longer on screen.
@MainActor
final class AttachmentPreviewSourceTests: XCTestCase {
    private func makeBar(_ items: [ChatInputAttachment]) -> (UIWindow, AttachmentsBar) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let bar = AttachmentsBar()
        bar.frame = CGRect(x: 0, y: 600, width: 390, height: 100)
        window.addSubview(bar)
        window.isHidden = false
        _ = bar.replaceItems(with: items)
        settle(bar)
        return (window, bar)
    }

    private func settle(_ bar: AttachmentsBar) {
        bar.layoutIfNeeded()
        bar.collectionView.layoutIfNeeded()
    }

    private func shownID(of view: UIView?) -> ChatInputAttachment.ID? {
        var ancestor = view
        while let current = ancestor {
            if let cell = current as? AttachmentsBar.AttachmentsImageCell { return cell.item?.id }
            ancestor = current.superview
        }
        return nil
    }

    func testSourceFollowsTheAttachmentAcrossReordering() {
        let items = (0 ..< 3).map { _ in ChatInputAttachment(type: .image) }
        let (window, bar) = makeBar(items)
        let id = items[0].id
        XCTAssertTrue(bar.previewSourceView(for: id) is UIImageView, "images zoom from the thumbnail")
        XCTAssertEqual(shownID(of: bar.previewSourceView(for: id)), id)

        _ = bar.replaceItems(with: items.reversed())
        settle(bar)
        XCTAssertEqual(shownID(of: bar.previewSourceView(for: id)), id)

        _ = bar.replaceItems(with: Array(items.dropFirst()))
        settle(bar)
        XCTAssertNil(bar.previewSourceView(for: id), "a removed attachment has no source")
        withExtendedLifetime(window) {}
    }

    func testOnlyTheRemoveGlyphRemovesAThumbnail() throws {
        let item = ChatInputAttachment(type: .image)
        let (window, bar) = makeBar([item])
        let cell = try XCTUnwrap(bar.collectionView.cellForItem(at: IndexPath(item: 0, section: 0)) as? AttachmentsBar.AttachmentsImageCell)
        cell.layoutIfNeeded()
        func removes(_ point: CGPoint) -> Bool {
            var view = window.hitTest(cell.convert(point, to: window), with: nil)
            while let current = view, !(current is DeleteButton) { view = current.superview }
            return view != nil
        }
        // The middle of the thumbnail opens the preview.
        XCTAssertFalse(removes(CGPoint(x: cell.bounds.midX, y: cell.bounds.midY)))
        XCTAssertTrue(removes(CGPoint(x: cell.bounds.maxX - 14, y: 14)))
        XCTAssertTrue(removes(CGPoint(x: cell.bounds.maxX - 34, y: 34)), "a finger-sized target around the glyph")
    }

    func testOffScreenOrDetachedAttachmentsHaveNoSource() {
        let items = (0 ..< 12).map { _ in ChatInputAttachment(type: .image) }
        let (window, bar) = makeBar(items)
        let id = items[0].id
        XCTAssertNotNil(bar.previewSourceView(for: id))
        let collection = bar.collectionView
        XCTAssertGreaterThan(collection.contentSize.width, collection.bounds.width * 2)
        collection.contentOffset.x = collection.contentSize.width - collection.bounds.width
        settle(bar)
        XCTAssertNil(bar.previewSourceView(for: id), "the first thumbnail is scrolled out of the bar")

        collection.contentOffset.x = 0
        bar.frame.origin.y = window.bounds.height + 40
        settle(bar)
        XCTAssertNil(bar.previewSourceView(for: id), "the bar's row is below the screen")

        bar.removeFromSuperview()
        bar.frame.origin.y = 600
        XCTAssertNil(bar.previewSourceView(for: id))
    }
}
