//
//  BranchNavigatorView.swift
//  YachiyoChatUI
//
//  "⑂ 2/3 ‹ ›" above a message that has siblings, as on the desktop.
//

import MarkdownView
import UIKit
import YachiyoMaterial

final class BranchNavigatorView: MessageListRowView {
    static let height: CGFloat = 44

    var position: MessageListView.BranchPosition? {
        didSet {
            guard oldValue != position else { return }
            update()
        }
    }
    var onStep: ((Int) -> Void)?

    private let icon = UIImageView(image: UIImage(systemName: "arrow.triangle.branch"))
    private let label = UILabel()
    private let previous = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = YachiyoFonts.meta()
        contentView.addSubview(icon)
        contentView.addSubview(label)
        previous.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        previous.accessibilityIdentifier = "branch.previous"
        previous.accessibilityLabel = String.localized("Previous reply")
        previous.addAction(UIAction { [weak self] _ in self?.step(-1) }, for: .touchUpInside)
        nextButton.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        nextButton.accessibilityIdentifier = "branch.next"
        nextButton.accessibilityLabel = String.localized("Next reply")
        nextButton.addAction(UIAction { [weak self] _ in self?.step(1) }, for: .touchUpInside)
        contentView.addSubview(previous)
        contentView.addSubview(nextButton)
    }

    private func step(_ offset: Int) {
        UISelectionFeedbackGenerator().selectionChanged()
        onStep?(offset)
    }

    override func themeDidUpdate() {
        super.themeDidUpdate()
        icon.tintColor = .yachiyo(.textMuted)
        label.textColor = .yachiyo(.textSecondary)
        previous.tintColor = .yachiyo(.textSecondary)
        nextButton.tintColor = .yachiyo(.textSecondary)
    }

    private func update() {
        guard let position else { return }
        label.text = "\(position.index + 1)/\(position.count)"
        previous.isEnabled = position.index > 0
        nextButton.isEnabled = position.index < position.count - 1
        setNeedsContentLayout()
    }

    override func layoutContent() {
        let height = contentView.bounds.height
        icon.frame = CGRect(x: 0, y: (height - 14) / 2, width: 14, height: 14)
        label.sizeToFit()
        label.frame.origin = CGPoint(x: icon.frame.maxX + 6, y: (height - label.bounds.height) / 2)
        previous.frame = CGRect(x: label.frame.maxX + 4, y: 0, width: 44, height: height)
        nextButton.frame = CGRect(x: previous.frame.maxX, y: 0, width: 44, height: height)
    }
}
