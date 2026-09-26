//
//  PlanCardView.swift
//  YachiyoChatUI
//
//  Plan Mode document: title, status pill, a six-line preview (tap to read in full), and the
//  request-changes / accept / accept-and-hand-off actions while it is pending.
//

import MarkdownView
import UIKit
import YachiyoMaterial

final class PlanCardView: MessageListRowView {
    static let padding: CGFloat = 16
    static let buttonHeight: CGFloat = 44
    static let previewLines = 6
    static let cornerRadius: CGFloat = 16

    var plan: MessageListView.PlanCard? {
        didSet {
            guard oldValue != plan else { return }
            rebuild()
        }
    }
    var onAction: ((PlanCardAction) -> Void)?

    private let card = UIView()
    private let titleLabel = UILabel()
    private let statusLabel = PaddedLabel()
    private let previewLabel = UILabel()
    private let buttons = UIStackView()
    private var shadowPathSize: CGSize?

    /// Dynamic colors are created once; layers get them resolved in `themeDidUpdate`.
    private enum Palette {
        static let surface = UIColor.yachiyo(.surface)
        static let shadow = YachiyoStyle.ink(0.06)
        static let ink = UIColor.yachiyo(.ink)
        static let textSecondary = UIColor.yachiyo(.textSecondary)
        static let pendingStatusBackground = YachiyoStyle.ink(0.06)
        static let acceptedStatusBackground = UIColor.yachiyo(.accent, alpha: 0.12)
        static let accentStrong = UIColor.yachiyo(.accentStrong)
    }

    /// Scaled fonts per Dynamic Type size, instead of new font objects on every measurement.
    private struct Fonts {
        let meta: UIFont
        let caption: UIFont
        let cardTitleStrong: UIFont

        private static var cache: (category: UIContentSizeCategory, fonts: Fonts)?

        static var current: Fonts {
            let category = UITraitCollection.current.preferredContentSizeCategory
            if let cache, cache.category == category { return cache.fonts }
            let fonts = Fonts(meta: YachiyoFonts.meta(), caption: YachiyoFonts.caption(), cardTitleStrong: YachiyoFonts.cardTitleStrong())
            cache = (category, fonts)
            return fonts
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.layer.cornerRadius = Self.cornerRadius
        card.layer.cornerCurve = .continuous
        card.layer.shadowOffset = CGSize(width: 0, height: 8)
        card.layer.shadowRadius = 12
        card.layer.shadowOpacity = 1
        contentView.addSubview(card)

        let fonts = Fonts.current
        titleLabel.font = fonts.cardTitleStrong
        titleLabel.text = String.localized("Execution plan")
        titleLabel.textColor = Palette.ink
        card.addSubview(titleLabel)

        statusLabel.font = fonts.caption
        statusLabel.layer.cornerRadius = 9
        statusLabel.clipsToBounds = true
        card.addSubview(statusLabel)

        previewLabel.numberOfLines = Self.previewLines
        previewLabel.font = fonts.meta
        previewLabel.textColor = Palette.textSecondary
        previewLabel.isUserInteractionEnabled = true
        previewLabel.accessibilityIdentifier = "plan.open"
        previewLabel.accessibilityTraits.insert(.button)
        previewLabel.accessibilityHint = String.localized("Read the full plan")
        previewLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openPlan)))
        card.addSubview(previewLabel)

        buttons.axis = .horizontal
        buttons.spacing = 8
        buttons.distribution = .fillEqually
        buttons.addArrangedSubview(makeButton(String.localized("Request changes"), "pencil.line", "plan.revise", .requestChanges, emphasized: false))
        buttons.addArrangedSubview(makeButton(String.localized("Accept"), "checkmark.circle", "plan.accept", .accept, emphasized: true))
        buttons.addArrangedSubview(makeButton(String.localized("Accept & hand off"), "arrow.triangle.branch", "plan.handoff", .acceptAndHandoff, emphasized: false))
        card.addSubview(buttons)
    }

    private func makeButton(_ title: String, _ symbol: String, _ identifier: String, _ action: PlanCardAction, emphasized: Bool) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        configuration.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(scale: .small))
        configuration.imagePadding = 4
        configuration.background.cornerRadius = 10
        configuration.background.backgroundColor = emphasized ? .yachiyo(.accent, alpha: 0.08) : YachiyoStyle.ink(0.04)
        configuration.baseForegroundColor = emphasized ? .yachiyo(.accentStrong) : .yachiyo(.ink)
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = YachiyoFonts.caption()
            return attributes
        }
        let button = UIButton(configuration: configuration)
        button.accessibilityIdentifier = identifier
        button.addAction(UIAction { [weak self] _ in self?.onAction?(action) }, for: .touchUpInside)
        return button
    }

    @objc private func openPlan() {
        onAction?(.open)
    }

    override func themeDidUpdate() {
        super.themeDidUpdate()
        // Layer colors do not follow trait or Yachiyo theme changes on their own.
        card.layer.backgroundColor = Palette.surface.resolvedColor(with: traitCollection).cgColor
        card.layer.shadowColor = Palette.shadow.resolvedColor(with: traitCollection).cgColor
        let fonts = Fonts.current
        titleLabel.font = fonts.cardTitleStrong
        statusLabel.font = fonts.caption
        previewLabel.font = fonts.meta
        updateStatus()
    }

    private func updateStatus() {
        let pending = plan?.isPending ?? true
        statusLabel.text = pending ? String.localized("Ready") : String.localized("Accepted")
        let background = pending ? Palette.pendingStatusBackground : Palette.acceptedStatusBackground
        statusLabel.layer.backgroundColor = background.resolvedColor(with: traitCollection).cgColor
        statusLabel.textColor = pending ? Palette.textSecondary : Palette.accentStrong
    }

    private func rebuild() {
        accessibilityIdentifier = "plan.card"
        previewLabel.text = plan?.content
        buttons.isHidden = !(plan?.isPending ?? false)
        updateStatus()
        setNeedsContentLayout()
    }

    override func layoutContent() {
        card.frame = contentView.bounds
        if shadowPathSize != card.bounds.size {
            // An explicit path spares Core Animation an offscreen pass to find the shadow's shape.
            shadowPathSize = card.bounds.size
            card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: Self.cornerRadius).cgPath
        }
        let padding = Self.padding
        let width = card.bounds.width - padding * 2
        let statusSize = statusLabel.intrinsicContentSize
        statusLabel.frame = CGRect(x: card.bounds.width - padding - statusSize.width, y: padding, width: statusSize.width, height: statusSize.height)
        titleLabel.frame = CGRect(x: padding, y: padding, width: max(0, width - statusSize.width - 8), height: Self.headerHeight)
        let previewHeight = Self.previewHeight(for: plan?.content ?? "", width: width)
        previewLabel.frame = CGRect(x: padding, y: titleLabel.frame.maxY + 8, width: width, height: previewHeight)
        buttons.axis = Self.stacksActions(width: width) ? .vertical : .horizontal
        buttons.frame = CGRect(x: padding, y: previewLabel.frame.maxY + 12, width: width, height: Self.actionsHeight(width: width))
    }

    private struct PreviewKey: Hashable {
        let prefix: Substring
        let width: CGFloat
        let category: UIContentSizeCategory
    }

    private static var previewHeights: [PreviewKey: CGFloat] = [:]

    static func previewHeight(for content: String, width: CGFloat) -> CGFloat {
        let font = Fonts.current.meta
        let clampedHeight = ceil(font.lineHeight * CGFloat(previewLines))
        let prefix = previewPrefix(of: content, width: width, font: font)
        let key = PreviewKey(prefix: prefix, width: width, category: UITraitCollection.current.preferredContentSizeCategory)
        if let cached = previewHeights[key] { return cached }
        let measured = ceil((String(prefix) as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        ).height)
        let height = max(44, min(measured, clampedHeight))
        if previewHeights.count > 64 { previewHeights.removeAll() }
        previewHeights[key] = height
        return height
    }

    /// The preview shows at most six lines, so only text that can reach the seventh line matters:
    /// six line breaks, or enough characters to fill six lines at the narrowest plausible glyph
    /// advance. Either prefix already measures at least six lines, so the clamp is unchanged.
    private static func previewPrefix(of content: String, width: CGFloat, font: UIFont) -> Substring {
        let charactersPerLine = Int(width / max(1, font.pointSize * 0.15)) + 1
        let characterLimit = charactersPerLine * previewLines
        var lineBreaks = 0
        var end = content.startIndex
        var count = 0
        while end < content.endIndex, count < characterLimit {
            if content[end].isNewline {
                lineBreaks += 1
                if lineBreaks == previewLines { break }
            }
            end = content.index(after: end)
            count += 1
        }
        return content[..<end]
    }

    private static func stacksActions(width: CGFloat) -> Bool {
        width < 480 || Fonts.current.caption.pointSize > 18
    }

    private static var headerHeight: CGFloat {
        let fonts = Fonts.current
        return ceil(max(fonts.cardTitleStrong.lineHeight, fonts.caption.lineHeight + 4))
    }

    private static func actionsHeight(width: CGFloat) -> CGFloat {
        let rowHeight = max(buttonHeight, ceil(Fonts.current.caption.lineHeight) + 20)
        return stacksActions(width: width) ? rowHeight * 3 + 16 : rowHeight
    }

    static func height(for plan: MessageListView.PlanCard, width: CGFloat) -> CGFloat {
        let inner = width - padding * 2
        var height = padding + headerHeight + 8 + previewHeight(for: plan.content, width: inner) + padding
        if plan.isPending { height += 12 + actionsHeight(width: inner) }
        return height
    }
}

final class PaddedLabel: UILabel {
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 14, height: size.height + 4)
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 7, dy: 2))
    }
}
