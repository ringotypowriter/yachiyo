//
//  Created by ktiays on 2025/2/7.
//  Copyright (c) 2025 ktiays. All rights reserved.
//

import ListViewKit
import Litext
import MarkdownView
import UIKit
import YachiyoMaterial

class MessageListRowView: ListRowView, UIContextMenuInteractionDelegate {
    var theme: MarkdownTheme = .default {
        didSet {
            guard !hasAppliedTheme || oldValue != theme else { return }
            hasAppliedTheme = true
            themeDidUpdate()
            setNeedsContentLayout()
        }
    }

    private var hasAppliedTheme = false

    let contentView = UIView()
    var contextMenuProvider: ((CGPoint) -> UIMenu?)?

    /// Space between the content and the next row. Response chunks use MarkdownView's block
    /// spacing here instead of the standard inset.
    var rowBottomInset: CGFloat = MessageListView.listRowInsets.bottom {
        didSet {
            guard oldValue != rowBottomInset else { return }
            setNeedsContentLayout()
        }
    }

    /// ListViewKit marks every visible row for layout on every scroll frame. Rows lay out their
    /// content only when their size changed or `setNeedsContentLayout()` was called.
    private var needsContentLayout = true
    private var lastLayoutSize: CGSize?
    private(set) var representedEntryID: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = false // tool tip will extend out
        addSubview(contentView)
        contentView.isUserInteractionEnabled = true

        contentView.addInteraction(UIContextMenuInteraction(delegate: self))

        // Layer colors are resolved once; refresh them when the appearance or Yachiyo theme changes.
        registerForTraitChanges([
            UITraitUserInterfaceStyle.self,
            UITraitPreferredContentSizeCategory.self,
            UITraitLayoutDirection.self,
        ]) { (row: MessageListRowView, _: UITraitCollection) in
            row.themeDidUpdate()
            row.setNeedsContentLayout()
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(yachiyoStyleDidChange),
            name: YachiyoStyle.didChangeNotification,
            object: nil
        )
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func yachiyoStyleDidChange() {
        themeDidUpdate()
        setNeedsContentLayout()
    }

    func setNeedsContentLayout() {
        needsContentLayout = true
        setNeedsLayout()
    }

    final override func layoutSubviews() {
        super.layoutSubviews()
        if !hasAppliedTheme {
            // Rows used outside the list (and never assigned a theme) still get their colors.
            hasAppliedTheme = true
            themeDidUpdate()
        }
        guard needsContentLayout || lastLayoutSize != bounds.size else { return }
        needsContentLayout = false
        lastLayoutSize = bounds.size

        let insets = MessageListView.listRowInsets
        contentView.frame = CGRect(
            x: insets.left,
            y: 0,
            width: bounds.width - insets.horizontal,
            height: max(0, bounds.height - rowBottomInset)
        )
        layoutContent()
    }

    /// Lays out subviews inside `contentView`; runs only when the row needs it.
    func layoutContent() {}

    /// Applies theme-derived fonts and colors. Called on theme, trait and Yachiyo style changes,
    /// never per layout pass.
    func themeDidUpdate() {}

    override func prepareForReuse() {
        super.prepareForReuse()
        contextMenuProvider = nil
        setNeedsContentLayout()
    }

    /// Called before each configure. Moving the row to a different entry ends what the reader was
    /// doing with the old one (text selection, an open menu); updating the same entry keeps it.
    func represent(entryID: String) {
        guard representedEntryID != entryID else { return }
        representedEntryID = entryID
        clearTextSelection()
        if isMenuPresented {
            contentView.interactions.compactMap { $0 as? UIContextMenuInteraction }.forEach { $0.dismissMenu() }
        }
    }

    /// True while the reader is working with this row: its menu is up or its text is selected.
    /// The timeline keeps a held row in place instead of following newer content.
    var isHeldByReader: Bool {
        isMenuPresented || textLabels().contains { $0.selectionRange != nil }
    }

    /// Called when the row's menu has gone; a selection ends without notice.
    var readerDidReleaseRow: (() -> Void)?

    private(set) var isMenuPresented = false

    /// Replaces this row's text. Litext keeps a selection's range across text replacement, so a
    /// selection survives only while every character up to its end is unchanged, as when a reply
    /// streams in after it; otherwise it ends rather than silently cover different characters.
    func updatingText(_ update: () -> Void) {
        let anchors = textLabels().compactMap { label in
            label.selectionRange
                .flatMap { TextSelectionAnchor(range: $0, in: label.attributedText.string) }
                .map { (label, $0) }
        }
        update()
        for (label, anchor) in anchors where !anchor.holds(in: label.attributedText.string) {
            label.clearSelection()
        }
    }

    private func clearTextSelection() {
        textLabels().forEach { $0.clearSelection() }
    }

    private func textLabels() -> [LTXLabel] {
        var labels: [LTXLabel] = []
        var queue: [UIView] = subviews
        var index = 0
        while index < queue.count {
            let view = queue[index]
            index += 1
            if let label = view as? LTXLabel { labels.append(label) }
            queue.append(contentsOf: view.subviews)
        }
        return labels
    }

    // MARK: - UIContextMenuInteractionDelegate

    func contextMenuInteraction(
        _: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard let menu = contextMenuProvider?(location) else { return nil }
        return .init {
            guard let snapshot = self.contentView.snapshotView(afterScreenUpdates: false) else {
                return nil
            }

            let controller = UIViewController()
            controller.preferredContentSize = CGSize(
                width: self.contentView.bounds.width + 16,
                height: self.contentView.bounds.height + 16
            )
            controller.view.backgroundColor = .systemBackground
            controller.view.addSubview(snapshot)
            snapshot.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                snapshot.topAnchor.constraint(equalTo: controller.view.topAnchor, constant: 8),
                snapshot.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor, constant: -8),
                snapshot.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor, constant: 8),
                snapshot.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor, constant: -8),
            ])
            return controller
        } actionProvider: { _ in
            menu
        }
    }

    func contextMenuInteraction(
        _: UIContextMenuInteraction,
        willDisplayMenuFor _: UIContextMenuConfiguration,
        animator _: (any UIContextMenuInteractionAnimating)?
    ) {
        isMenuPresented = true
    }

    func contextMenuInteraction(
        _: UIContextMenuInteraction,
        willEndFor _: UIContextMenuConfiguration,
        animator: (any UIContextMenuInteractionAnimating)?
    ) {
        let release = { [weak self] in
            guard let self, isMenuPresented else { return }
            isMenuPresented = false
            readerDidReleaseRow?()
        }
        // The row stays held until the preview has settled back onto it.
        if let animator { animator.addCompletion(release) } else { release() }
    }
}

/// A text selection pinned to the characters it covers. It holds in new text that starts with
/// the same UTF-16 code units through the selection's end; ranges are UTF-16, like `NSRange`.
struct TextSelectionAnchor: Equatable {
    let range: NSRange
    private let prefix: String

    init?(range: NSRange, in text: String) {
        let text = text as NSString
        guard range.length > 0, NSMaxRange(range) <= text.length else { return nil }
        self.range = range
        prefix = text.substring(to: NSMaxRange(range))
    }

    func holds(in text: String) -> Bool {
        let text = text as NSString
        guard NSMaxRange(range) <= text.length else { return false }
        // Literal: canonically equivalent spellings differ in length, so they move the range.
        return text.substring(to: NSMaxRange(range)).compare(prefix, options: .literal) == .orderedSame
    }
}
