//
//  UserAttachmentView.swift
//  LanguageModelChatUI
//

import UIKit

final class UserAttachmentView: MessageListRowView {
    private lazy var attachmentsBar: AttachmentsBar = .init()

    override init(frame: CGRect) {
        super.init(frame: frame)

        attachmentsBar.inset = .zero
        attachmentsBar.isDeletable = false
        attachmentsBar.animatingDifferences = false
        attachmentsBar.collectionView.alwaysBounceHorizontal = false
        contentView.addSubview(attachmentsBar)
    }

    @available(*, unavailable)
    @MainActor required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutContent() {
        let idealWidth = attachmentsBar.idealSize().width
        let bounds = contentView.bounds
        let width = min(idealWidth, bounds.width)
        attachmentsBar.frame = .init(
            x: bounds.width - width,
            y: 0,
            width: width,
            height: bounds.height
        )
    }

    /// Attachment ids are stable across rebuilds, so an unchanged message is a no-op here and a
    /// reused row only inserts, removes or reconfigures what differs.
    func update(with attachments: MessageListView.Attachments) {
        guard attachmentsBar.replaceItems(with: attachments.items) else { return }
        setNeedsContentLayout()
    }
}
