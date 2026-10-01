//
//  EarlierHistoryView.swift
//  YachiyoChatUI
//
//  The first row while older messages exist: loads them, shows progress, or retries.
//

import MarkdownView
import UIKit
import YachiyoMaterial

/// Whether messages older than the loaded ones exist, and the state of fetching them.
public enum EarlierHistoryState: Equatable, Sendable {
    case none
    case available
    case loading
    case failed
}

final class EarlierHistoryView: MessageListRowView {
    static let height: CGFloat = 44

    var state: EarlierHistoryState = .none {
        didSet {
            guard oldValue != state else { return }
            update()
        }
    }
    var onRequest: (() -> Void)?

    private let button = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        button.titleLabel?.font = YachiyoFonts.meta()
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.accessibilityIdentifier = "thread.earlierHistory"
        button.addAction(UIAction { [weak self] _ in self?.onRequest?() }, for: .touchUpInside)
        contentView.addSubview(button)
        spinner.isUserInteractionEnabled = false
        contentView.addSubview(spinner)
        update()
    }

    override func themeDidUpdate() {
        super.themeDidUpdate()
        button.tintColor = .yachiyo(.textSecondary)
        spinner.color = .yachiyo(.textMuted)
    }

    private func update() {
        let title: String
        switch state {
        case .none: title = ""
        case .available: title = String.localized("Load earlier messages")
        case .loading: title = String.localized("Loading earlier messages…")
        case .failed: title = String.localized("Retry loading earlier messages")
        }
        button.setTitle(title, for: .normal)
        button.isEnabled = state == .available || state == .failed
        if state == .loading { spinner.startAnimating() } else { spinner.stopAnimating() }
        setNeedsContentLayout()
    }

    override func layoutContent() {
        let bounds = contentView.bounds
        let titleWidth = min(button.intrinsicContentSize.width + 24, bounds.width - 56)
        // The whole row height stays tappable; the spinner sits before the title.
        button.frame = CGRect(x: (bounds.width - titleWidth) / 2, y: 0, width: titleWidth, height: bounds.height)
        spinner.center = CGPoint(x: button.frame.minX - 12, y: bounds.midY)
    }
}
