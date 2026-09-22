import UIKit
import YachiyoMaterial

/// The 8pt status dot: breathing `accentStrong` while running, solid `accent` when a run finished
/// unseen. Breathing respects Reduce Motion.
final class StatusDotView: UIView {
    enum Status { case none, running, unread }

    var status: Status = .none { didSet { update() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 4
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { CGSize(width: 8, height: 8) }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        update()
    }

    private func update() {
        layer.removeAnimation(forKey: "breathe")
        switch status {
        case .none:
            isHidden = true
            accessibilityLabel = nil
        case .running:
            isHidden = false
            backgroundColor = .yachiyo(.accentStrong)
            accessibilityLabel = String(localized: "Running")
            guard !UIAccessibility.isReduceMotionEnabled else { return }
            let animation = CABasicAnimation(keyPath: "opacity")
            animation.fromValue = 1
            animation.toValue = 0.58
            animation.duration = 0.9
            animation.autoreverses = true
            animation.repeatCount = .infinity
            layer.add(animation, forKey: "breathe")
        case .unread:
            isHidden = false
            backgroundColor = .yachiyo(.accent)
            accessibilityLabel = String(localized: "Completed, not viewed")
        }
    }
}

extension UIImage {
    /// A Lucide glyph from the asset catalog (`pnpm run ios:icons`).
    static func lucide(_ name: String) -> UIImage? {
        UIImage(named: "Lucide/\(name)")?.withRenderingMode(.alwaysTemplate)
    }
}
