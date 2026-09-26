//
//  AttachmentsBar+Cell.swift
//  LanguageModelChatUI
//

import UIKit

extension AttachmentsBar {
    class AttachmentsImageCell: UICollectionViewCell {
        let contentContainer = UIView()
        let iconView = UIImageView()

        let deleteButton = DeleteButton()

        var isDeletable: Bool = true {
            didSet { setNeedsLayout() }
        }

        var item: Item?

        var attachmentBarView: AttachmentsBar? {
            var view: UIView = self
            while !(view is AttachmentsBar) {
                guard let nextView = view.superview else { break }
                view = nextView
            }
            return view as? AttachmentsBar
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            // Round the image itself rather than clipping the container with its subviews: the
            // same shape without an offscreen pass. The delete button sits inside the bounds.
            contentContainer.layer.cornerRadius = 10
            contentContainer.layer.cornerCurve = .continuous
            contentContainer.backgroundColor = .gray.withAlphaComponent(0.1)
            contentView.addSubview(contentContainer)

            iconView.contentMode = .scaleAspectFill
            iconView.layer.cornerRadius = 10
            iconView.layer.cornerCurve = .continuous
            iconView.clipsToBounds = true
            contentContainer.addSubview(iconView)

            contentContainer.addSubview(deleteButton)

            deleteButton.actionBlock = { [weak self] in
                self?.attachmentBarView?.delete(itemIdentifier: self?.item?.id)
            }
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            contentContainer.frame = contentView.bounds
            iconView.frame = contentView.bounds
            deleteButton.isHidden = !isDeletable
            deleteButton.frame = .init(
                x: bounds.width - 44,
                y: 0,
                width: 44,
                height: 44
            )
        }

        func configure(item: Item) {
            let previous = self.item
            self.item = item
            if previous?.id == item.id, previous?.previewImageData == item.previewImageData, iconView.image != nil {
                return
            }
            let pointSize = AttachmentsBar.imageItemSize
            let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 3
            let key = AttachmentThumbnailCache.key(id: item.id, data: item.previewImageData, pointSize: pointSize, scale: scale)
            let cache = AttachmentThumbnailCache.shared
            if let image = cache.cachedImage(for: key) {
                iconView.image = image
                return
            }
            iconView.image = nil
            cache.loadImage(for: key, data: item.previewImageData, pointSize: pointSize, scale: scale) { [weak self] image in
                guard let self, self.item?.id == item.id, self.item?.previewImageData.count == item.previewImageData.count else { return }
                iconView.image = image
            }
        }
    }
}

extension AttachmentsBar {
    class AttachmentsTextCell: UICollectionViewCell {
        let contentContainer = UIView()
        let nameLabel = UILabel()
        let textLabel = UILabel()

        let deleteButton = DeleteButton()
        let iconSize: CGFloat = 20
        let inset: CGFloat = 4

        var item: Item?

        var isDeletable: Bool = true {
            didSet { setNeedsLayout() }
        }

        var attachmentBarView: AttachmentsBar? {
            var view: UIView = self
            while !(view is AttachmentsBar) {
                guard let nextView = view.superview else { break }
                view = nextView
            }
            return view as? AttachmentsBar
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            contentContainer.clipsToBounds = true
            contentContainer.layer.cornerRadius = 10
            contentContainer.layer.cornerCurve = .continuous
            contentContainer.backgroundColor = .gray.withAlphaComponent(0.1)
            contentView.addSubview(contentContainer)

            nameLabel.font = .systemFont(ofSize: 12, weight: .semibold)
            nameLabel.textColor = .label
            nameLabel.numberOfLines = 1
            nameLabel.textAlignment = .left
            nameLabel.lineBreakMode = .byTruncatingTail
            contentContainer.addSubview(nameLabel)

            textLabel.font = .systemFont(ofSize: 12, weight: .regular)
            textLabel.textColor = .secondaryLabel
            textLabel.contentMode = .topLeft
            textLabel.numberOfLines = 0
            textLabel.textAlignment = .left
            textLabel.lineBreakMode = .byTruncatingTail
            contentContainer.addSubview(textLabel)

            contentContainer.addSubview(deleteButton)

            deleteButton.actionBlock = { [weak self] in
                self?.attachmentBarView?.delete(itemIdentifier: self?.item?.id)
            }
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            contentContainer.frame = contentView.bounds
            nameLabel.frame = .init(
                x: inset,
                y: inset,
                width: bounds.width - inset * 3 - (isDeletable ? iconSize : 0),
                height: iconSize
            )
            deleteButton.isHidden = !isDeletable
            deleteButton.frame = .init(
                x: bounds.width - 44,
                y: 0,
                width: 44,
                height: 44
            )
            textLabel.frame = .init(
                x: inset,
                y: nameLabel.frame.maxY + inset,
                width: bounds.width - inset * 2,
                height: bounds.height - nameLabel.frame.maxY - inset * 2
            )
        }

        func configure(item: Item) {
            self.item = item
            nameLabel.text = item.name
            var text = item.textContent.replacingOccurrences(of: "\n", with: " ")
            if text.count > 500 { text = String(text.prefix(500)) }
            textLabel.text = text
        }
    }
}

extension AttachmentsBar {
    class AttachmentsAudioCell: AttachmentsTextCell, UIGestureRecognizerDelegate {
        private lazy var quickLookTap: UITapGestureRecognizer = {
            let gesture = UITapGestureRecognizer(target: self, action: #selector(handleTap))
            gesture.cancelsTouchesInView = true
            gesture.delegate = self
            return gesture
        }()

        override init(frame: CGRect) {
            super.init(frame: frame)
            contentContainer.isUserInteractionEnabled = true
            contentContainer.addGestureRecognizer(quickLookTap)
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError()
        }

        override func configure(item: Item) {
            super.configure(item: item)
            textLabel.text = item.textContent
        }

        func gestureRecognizer(_: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            if touch.view?.isDescendant(of: deleteButton) == true {
                return false
            }
            return true
        }

        @objc private func handleTap() {
            guard let item else { return }
            contentView.puddingAnimate()
            attachmentBarView?.presentPreview(for: item)
        }
    }
}
