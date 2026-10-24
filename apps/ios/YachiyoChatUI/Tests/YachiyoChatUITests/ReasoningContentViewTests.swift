import UIKit
import XCTest
@testable import YachiyoChatUI

@MainActor
final class ReasoningContentViewTests: XCTestCase {
    func testCompletedReasoningHidesDotsOnFirstRender() throws {
        let row = ReasoningContentView()
        row.isThinking = false
        row.text = "Reasoning already finished"
        let symbol = try XCTUnwrap(loadingSymbol(in: row))
        XCTAssertTrue(symbol.isHidden)
    }

    func testDotsFollowThinkingStateAcrossRowReuse() throws {
        let row = ReasoningContentView()
        let symbol = try XCTUnwrap(loadingSymbol(in: row))
        row.isThinking = true
        XCTAssertFalse(symbol.isHidden)
        row.isThinking = false
        XCTAssertTrue(symbol.isHidden)
        row.isThinking = true
        XCTAssertFalse(symbol.isHidden)
    }

    func testCompletedReasoningRemovesWaveAnimationInWindow() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        let controller = UIViewController()
        window.rootViewController = controller
        let row = ReasoningContentView()
        controller.view.addSubview(row)
        window.isHidden = false
        defer { window.isHidden = true }
        let symbol = try XCTUnwrap(loadingSymbol(in: row))
        XCTAssertFalse(hasAnimation(in: symbol.layer))
        row.isThinking = true
        XCTAssertTrue(hasAnimation(in: symbol.layer))
        row.isThinking = false
        XCTAssertFalse(hasAnimation(in: symbol.layer))
    }

    private func loadingSymbol(in view: UIView) -> LoadingSymbol? {
        if let symbol = view as? LoadingSymbol { return symbol }
        return view.subviews.lazy.compactMap { self.loadingSymbol(in: $0) }.first
    }

    private func hasAnimation(in layer: CALayer) -> Bool {
        !(layer.animationKeys() ?? []).isEmpty || (layer.sublayers ?? []).contains { hasAnimation(in: $0) }
    }
}
