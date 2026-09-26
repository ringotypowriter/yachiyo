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

    /// Called before each configure. Moving the row to a different entry clears text selection;
    /// updating the same entry keeps it.
    func represent(entryID: String) {
        guard representedEntryID != entryID else { return }
        representedEntryID = entryID
        clearTextSelection()
    }

    private func clearTextSelection() {
        var queue: [UIView] = subviews
        var index = 0
        while index < queue.count {
            let view = queue[index]
            index += 1
            if let label = view as? LTXLabel {
                label.clearSelection()
            }
            queue.append(contentsOf: view.subviews)
        }
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
}
