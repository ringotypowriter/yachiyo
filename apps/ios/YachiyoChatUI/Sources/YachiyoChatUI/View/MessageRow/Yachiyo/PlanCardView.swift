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
    static let buttonHeight: CGFloat = 40
    static let previewLines = 6

    var plan: MessageListView.PlanCard? { didSet { rebuild() } }
    var onAction: ((PlanCardAction) -> Void)?

    private let card = UIView()
    private let titleLabel = UILabel()
    private let statusLabel = PaddedLabel()
    private let previewLabel = UILabel()
    private let buttons = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.layer.cornerRadius = 16
        card.layer.cornerCurve = .continuous
        card.layer.shadowOffset = CGSize(width: 0, height: 8)
        card.layer.shadowRadius = 12
        card.layer.shadowOpacity = 1
        contentView.addSubview(card)

        titleLabel.font = YachiyoFonts.cardTitleStrong()
        titleLabel.text = String.localized("Execution plan")
        card.addSubview(titleLabel)

        statusLabel.font = YachiyoFonts.caption()
        statusLabel.layer.cornerRadius = 9
        statusLabel.clipsToBounds = true
        card.addSubview(statusLabel)

        previewLabel.numberOfLines = Self.previewLines
        previewLabel.font = YachiyoFonts.meta()
        previewLabel.isUserInteractionEnabled = true
        previewLabel.accessibilityIdentifier = "plan.open"
        previewLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openPlan)))
        card.addSubview(previewLabel)

        buttons.axis = .horizontal
        buttons.spacing = 8
        buttons.distribution = .fillProportionally
        buttons.addArrangedSubview(makeButton(String.localized("Request changes"), "pencil.line", "plan.revise", .requestChanges, emphasized: false))
        buttons.addArrangedSubview(makeButton(String.localized("Accept"), "checkmark.circle", "plan.accept", .accept, emphasized: true))
        buttons.addArrangedSubview(makeButton(String.localized("Hand off"), "arrow.triangle.branch", "plan.handoff", .acceptAndHandoff, emphasized: true))
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
        card.backgroundColor = .yachiyo(.surface)
        card.layer.shadowColor = YachiyoStyle.ink(0.06).resolvedColor(with: traitCollection).cgColor
        titleLabel.textColor = .yachiyo(.ink)
        previewLabel.textColor = .yachiyo(.textSecondary)
        let pending = plan?.isPending ?? true
        statusLabel.text = pending ? String.localized("Ready") : String.localized("Accepted")
        statusLabel.backgroundColor = pending ? YachiyoStyle.ink(0.06) : .yachiyo(.accent, alpha: 0.12)
        statusLabel.textColor = pending ? .yachiyo(.textSecondary) : .yachiyo(.accentStrong)
    }

    private func rebuild() {
        accessibilityIdentifier = "plan.card"
        previewLabel.text = plan?.content
        buttons.isHidden = !(plan?.isPending ?? false)
        themeDidUpdate()
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        card.frame = contentView.bounds
        let padding = Self.padding
        let width = card.bounds.width - padding * 2
        let statusSize = statusLabel.intrinsicContentSize
        statusLabel.frame = CGRect(x: card.bounds.width - padding - statusSize.width, y: padding, width: statusSize.width, height: 18)
        titleLabel.frame = CGRect(x: padding, y: padding - 2, width: width - statusSize.width - 8, height: 22)
        let previewHeight = Self.previewHeight(for: plan?.content ?? "", width: width)
        previewLabel.frame = CGRect(x: padding, y: titleLabel.frame.maxY + 8, width: width, height: previewHeight)
        buttons.frame = CGRect(x: padding, y: previewLabel.frame.maxY + 12, width: width, height: Self.buttonHeight)
    }

    static func previewHeight(for content: String, width: CGFloat) -> CGFloat {
        let font = YachiyoFonts.meta()
        let full = ceil((content as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        ).height)
        return min(full, ceil(font.lineHeight * CGFloat(previewLines)))
    }

    static func height(for plan: MessageListView.PlanCard, width: CGFloat) -> CGFloat {
        let inner = width - padding * 2
        var height = padding + 22 + 8 + previewHeight(for: plan.content, width: inner) + padding
        if plan.isPending { height += 12 + buttonHeight }
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
