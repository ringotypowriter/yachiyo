//
//  LoadingSymbol.swift
//  LanguageModelChatUI
//

import UIKit

/// Three dots riding a sine wave. The render server animates them (a replicator with one keyframe
/// animation), so no main-thread work runs per frame, and the animation exists only while the
/// symbol is in a window and not hidden.
final class LoadingSymbol: UIView {
    var dotRadius: CGFloat = 2 {
        didSet { invalidateAnimation() }
    }

    var spacing: CGFloat = 3 {
        didSet { invalidateAnimation() }
    }

    var animationDuration: TimeInterval = 0.4 {
        didSet { invalidateAnimation() }
    }

    var animationInterval: TimeInterval = 0.1 {
        didSet { invalidateAnimation() }
    }

    override var isHidden: Bool {
        didSet { updateAnimationState() }
    }

    private static let animationKey = "wave"
    private let replicator = CAReplicatorLayer()
    private let dot = CALayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        replicator.instanceCount = 3
        replicator.addSublayer(dot)
        layer.addSublayer(replicator)
        updateDotColor()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (symbol: LoadingSymbol, _: UITraitCollection) in
            symbol.updateDotColor()
        }
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: dotRadius * 2 * 3 + spacing * 2, height: max(10, dotRadius * 2))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let totalWidth = dotRadius * 2 * 3 + spacing * 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        replicator.frame = bounds
        dot.frame = CGRect(
            x: (bounds.width - totalWidth) / 2,
            y: bounds.midY - dotRadius,
            width: dotRadius * 2,
            height: dotRadius * 2
        )
        dot.cornerRadius = dotRadius
        replicator.instanceTransform = CATransform3DMakeTranslation(dotRadius * 2 + spacing, 0, 0)
        CATransaction.commit()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateAnimationState()
    }

    private func updateDotColor() {
        dot.backgroundColor = UIColor.label.resolvedColor(with: traitCollection).cgColor
    }

    private func invalidateAnimation() {
        dot.removeAnimation(forKey: Self.animationKey)
        setNeedsLayout()
        updateAnimationState()
    }

    private func updateAnimationState() {
        let isVisible = window != nil && !isHidden
        guard isVisible else {
            dot.removeAnimation(forKey: Self.animationKey)
            return
        }
        guard dot.animation(forKey: Self.animationKey) == nil else { return }
        let duration = max(0.1, animationDuration)
        let steps = 24
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.y")
        animation.values = (0 ... steps).map { step in
            sin(Double(step) / Double(steps) * .pi * 2) * Double(dotRadius) * 1.2
        }
        animation.keyTimes = (0 ... steps).map { NSNumber(value: Double($0) / Double(steps)) }
        animation.duration = duration
        animation.repeatCount = .infinity
        // Keeps the loop through app backgrounding; removal is explicit above.
        animation.isRemovedOnCompletion = false
        dot.add(animation, forKey: Self.animationKey)
        // Each dot trails the previous one by the configured interval, like the drawn version.
        replicator.instanceDelay = animationInterval
    }
}
