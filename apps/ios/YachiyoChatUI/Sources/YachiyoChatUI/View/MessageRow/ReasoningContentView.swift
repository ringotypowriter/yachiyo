//
//  Created by ktiays on 2025/2/21.
//  Copyright (c) 2025 ktiays. All rights reserved.
//

import Litext
import UIKit

final class ReasoningContentView: MessageListRowView {
    private lazy var indicator: UIView = .init()
    private lazy var textView: LTXLabel = .init().with {
        $0.isSelectable = true
    }

    private lazy var thinkingTile: ThinkingTile = .init()

    static let paragraphStyle: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 3
        return style
    }()

    static let revealedTileHeight: CGFloat = 44
    static let unrevealedTileHeight: CGFloat = 70
    static let spacing: CGFloat = 12
    private static let tileContentLeading: CGFloat = 14
    private static let indicatorWidth: CGFloat = 2

    var thinkingDuration: TimeInterval = 0 {
        didSet {
            guard oldValue != thinkingDuration else { return }
            thinkingTile.thinkingDuration = thinkingDuration
        }
    }

    var thinkingTileTapHandler: ((_ newValue: Bool) -> Void)?

    var isRevealed: Bool = false {
        didSet {
            guard oldValue != isRevealed else { return }
            // Collapsed rows skip building the full reasoning text until they are revealed.
            if isRevealed { applyRevealedText() }
            isCollapsing = !isRevealed
            doWithAnimation({ [self] in
                thinkingTile.isRevealed = isRevealed
                setNeedsContentLayout()
                layoutIfNeeded()
            }, completion: { [self] in
                // Fade out first, then take the hidden text out of rendering.
                isCollapsing = false
                textView.isHidden = !isRevealed
            })
        }
    }

    private var isCollapsing = false

    var isThinking: Bool = false {
        didSet {
            guard oldValue != isThinking else { return }
            doWithAnimation { [self] in
                thinkingTile.isThinking = isThinking
                setNeedsContentLayout()
                layoutIfNeeded()
            }
        }
    }

    var text: String? {
        didSet {
            guard text != oldValue else { return }
            isRevealedTextStale = true
            if isRevealed { applyRevealedText() }
            // The tile shows the last 50 characters on one line; only those need rewriting.
            thinkingTile.thinkingContent = text.map { String($0.suffix(50)).replacingOccurrences(of: "\n", with: " ") }
            setNeedsContentLayout()
        }
    }

    /// The full text label is hidden while collapsed and filled in when first revealed.
    private var isRevealedTextStale = true

    private func applyRevealedText() {
        guard isRevealedTextStale else { return }
        isRevealedTextStale = false
        if let text {
            textView.attributedText = .init(string: text, attributes: [
                .font: theme.fonts.footnote,
                .foregroundColor: UIColor.secondaryLabel,
                .paragraphStyle: Self.paragraphStyle,
            ])
        } else {
            textView.attributedText = .init()
        }
    }

    override init(frame: CGRect) {
        var decisionFrame = frame
        if decisionFrame == .zero {
            // prevent unwanted animation with magic
            decisionFrame = .init(x: 0, y: 0, width: 512, height: 10)
        }
        super.init(frame: decisionFrame)

        contentView.clipsToBounds = false

        let tapGesture = UITapGestureRecognizer(target: self, action: #selector(handleThinkTileTap(_:)))
        thinkingTile.addGestureRecognizer(tapGesture)
        contentView.addSubview(thinkingTile)

        indicator.layer.cornerRadius = 1
        indicator.backgroundColor = .secondaryLabel
        indicator.alpha = 0.6
        contentView.addSubview(indicator)

        textView.backgroundColor = .clear
        contentView.addSubview(textView)
    }

    @available(*, unavailable)
    @MainActor required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func themeDidUpdate() {
        super.themeDidUpdate()
        thinkingTile.titleLabel.font = theme.fonts.body
        thinkingTile.thinkingContentFont = theme.fonts.footnote
        isRevealedTextStale = true
        if isRevealed { applyRevealedText() }
    }

    override func layoutContent() {
        thinkingTile.frame = .init(
            x: 0,
            y: 0,
            width: thinkingTile.intrinsicContentSize.width,
            height: isRevealed ? Self.revealedTileHeight : Self.unrevealedTileHeight
        )

        let contentLeading = thinkingTile.frame.minX + Self.tileContentLeading
        let indicatorLeading = thinkingTile.frame.minX
        let indicatorY = thinkingTile.frame.maxY + 12
        if isRevealed {
            indicator.isHidden = false
            indicator.frame = .init(
                x: indicatorLeading,
                y: indicatorY,
                width: Self.indicatorWidth,
                height: max(0, contentView.bounds.height - indicatorY)
            )
        } else {
            indicator.isHidden = true
            indicator.frame = .zero
        }

        let textViewOrigin = CGPoint(
            x: contentLeading,
            y: indicatorY
        )
        let textWidth = max(0, contentView.bounds.width - textViewOrigin.x)
        textView.preferredMaxLayoutWidth = textWidth
        textView.frame = .init(
            x: textViewOrigin.x,
            y: textViewOrigin.y,
            width: textWidth,
            height: isRevealed || isCollapsing ? ceil(textView.intrinsicContentSize.height) : 0
        )
        textView.alpha = isRevealed ? 1 : 0
        textView.isHidden = !isRevealed && !isCollapsing
    }

    @objc
    private func handleThinkTileTap(_: UITapGestureRecognizer) {
        thinkingTileTapHandler?(!isRevealed)
    }
}

extension ReasoningContentView {
    final class ThinkingTile: UIView {
        var thinkingDuration: TimeInterval = 0 {
            didSet {
                updateThinkingDurationText()
            }
        }

        var isRevealed: Bool = false {
            didSet {
                guard oldValue != isRevealed else { return }
                setNeedsLayout()
            }
        }

        var isThinking: Bool = true {
            didSet {
                guard oldValue != isThinking else { return }
                loadingSymbol.isHidden = !isThinking
                setNeedsLayout()
            }
        }

        var thinkingContentFont: UIFont = .systemFont(ofSize: 12) {
            didSet {
                guard oldValue != thinkingContentFont else { return }
                updateThinkingContent()
            }
        }

        var thinkingContent: String? {
            didSet {
                guard oldValue != thinkingContent else { return }
                updateThinkingContent()
            }
        }

        private func updateThinkingContent() {
            if let content = thinkingContent {
                textView.attributedText = .init(string: content, attributes: [
                    .font: thinkingContentFont,
                    .foregroundColor: UIColor.secondaryLabel,
                ])
            } else {
                textView.attributedText = .init()
            }
            if textView.bounds.width > 0 {
                doWithAnimation { self.layoutTextView() }
            } else {
                layoutTextView()
            }
        }

        lazy var titleLabel: UILabel = .init()

        private lazy var loadingSymbol: LoadingSymbol = .init()
        private lazy var textView: LTXLabel = .init()
        private lazy var textContainerView: UIView = .init()
        private lazy var arrowView: UIImageView = .init(
            image: UIImage(
                systemName: "chevron.right",
                withConfiguration: UIImage.SymbolConfiguration(scale: .small)
            )
        ).with {
            $0.contentMode = .scaleAspectFit
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            clipsToBounds = true

            backgroundColor = .secondarySystemFill.withAlphaComponent(0.08)
            layer.cornerRadius = 14
            layer.cornerCurve = .continuous

            titleLabel.textAlignment = .natural
            addSubview(titleLabel)

            loadingSymbol.dotRadius = 1
            loadingSymbol.spacing = 2
            loadingSymbol.animationDuration = 0.9
            loadingSymbol.animationInterval = 0.24
            addSubview(loadingSymbol)

            textView.backgroundColor = .clear
            addSubview(textView)
            addSubview(textContainerView)
            textContainerView.addSubview(textView)

            // Create gradient mask using CAGradientLayer
            let gradientMask = CAGradientLayer()
            gradientMask.colors = [
                UIColor.black.cgColor,
                UIColor.black.withAlphaComponent(0).cgColor,
            ]
            gradientMask.startPoint = CGPoint(x: 0.8, y: 0.5)
            gradientMask.endPoint = CGPoint(x: 1.0, y: 0.5)
            textContainerView.layer.mask = gradientMask

            arrowView.tintColor = .label
            addSubview(arrowView)

            updateThinkingDurationText()
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func layoutSubviews() {
            super.layoutSubviews()

            let titleSize = titleLabel.intrinsicContentSize
            titleLabel.frame = .init(
                x: 14,
                y: isRevealed ? (bounds.height - ceil(titleSize.height)) / 2 : 12,
                width: ceil(titleSize.width),
                height: ceil(titleSize.height)
            )
            loadingSymbol.frame = .init(
                x: titleLabel.frame.maxX + 3,
                y: titleLabel.frame.midY - 4.5,
                width: loadingSymbol.intrinsicContentSize.width,
                height: 9
            )

            let arrowSize = arrowView.intrinsicContentSize
            arrowView.frame = .init(
                x: bounds.width - arrowSize.width - 12,
                y: (bounds.height - arrowSize.height) / 2,
                width: arrowSize.width,
                height: arrowSize.height
            )

            layoutTextView()

            if isRevealed {
                textView.alpha = 0
                arrowView.transform = .init(rotationAngle: .pi / 2)
            } else {
                textView.alpha = 1
                arrowView.transform = .identity
            }
        }

        private func updateThinkingDurationText() {
            let text = String.localized("Thought for \(Int(thinkingDuration)) seconds")
            titleLabel.text = text
        }

        override var intrinsicContentSize: CGSize {
            let titleSize = titleLabel.intrinsicContentSize
            return .init(
                width: titleSize.width + (isRevealed ? 80 : 180),
                height: titleSize.height
            )
        }

        private func layoutTextView() {
            textView.preferredMaxLayoutWidth = .infinity
            let textSize = textView.intrinsicContentSize
            let textWidth = ceil(textSize.width)
            let textHeight = ceil(textSize.height)
            let leftPadding = ReasoningContentView.tileContentLeading
            let rightPadding: CGFloat = 26
            textContainerView.frame = .init(
                x: leftPadding,
                y: ReasoningContentView.unrevealedTileHeight - textHeight - 12,
                width: max(0, bounds.width - leftPadding - rightPadding),
                height: textHeight
            )
            textContainerView.layer.mask?.frame = textContainerView.bounds
            textView.frame = .init(
                x: 0,
                y: 0,
                width: textWidth,
                height: textHeight
            )
        }
    }
}
