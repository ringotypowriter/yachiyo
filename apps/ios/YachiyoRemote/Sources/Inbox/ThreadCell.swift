import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// Inbox row: emoji (or a small dot), title in the color tag, one-line preview, optional device
/// name, and at most one trailing indicator (status dot, question, or star).
final class ThreadCell: UICollectionViewListCell {
    private let iconLabel = UILabel()
    private let placeholderDot = UIView()
    private let titleLabel = UILabel()
    private let lockView = UIImageView(image: .lucide("lock"))
    private let previewIcon = UIImageView()
    private let previewLabel = UILabel()
    private let deviceLabel = UILabel()
    private let statusDot = StatusDotView()
    private let starView = UIImageView(image: UIImage(systemName: "star.fill"))

    override init(frame: CGRect) {
        super.init(frame: frame)
        iconLabel.font = .systemFont(ofSize: 26)
        iconLabel.textAlignment = .center
        placeholderDot.layer.cornerRadius = 3
        titleLabel.font = YachiyoFonts.rowTitle()
        titleLabel.adjustsFontForContentSizeCategory = true
        previewLabel.font = YachiyoFonts.preview()
        previewLabel.adjustsFontForContentSizeCategory = true
        deviceLabel.font = YachiyoFonts.caption()
        lockView.contentMode = .scaleAspectFit
        previewIcon.contentMode = .scaleAspectFit
        starView.contentMode = .scaleAspectFit
        starView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 11)

        let iconContainer = UIView()
        iconContainer.addSubview(iconLabel)
        iconContainer.addSubview(placeholderDot)
        let titleRow = UIStackView(arrangedSubviews: [titleLabel, lockView])
        titleRow.spacing = 4
        titleRow.alignment = .center
        let previewRow = UIStackView(arrangedSubviews: [previewIcon, previewLabel])
        previewRow.spacing = 4
        previewRow.alignment = .center
        let texts = UIStackView(arrangedSubviews: [titleRow, previewRow, deviceLabel])
        texts.axis = .vertical
        texts.spacing = 2
        let trailing = UIStackView(arrangedSubviews: [statusDot, starView])
        trailing.axis = .vertical
        trailing.alignment = .center
        let row = UIStackView(arrangedSubviews: [iconContainer, texts, trailing])
        row.spacing = 12
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(row)
        [iconContainer, iconLabel, placeholderDot, lockView, previewIcon, starView].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
            contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
            iconContainer.widthAnchor.constraint(equalToConstant: 32),
            iconContainer.heightAnchor.constraint(equalToConstant: 32),
            iconLabel.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
            iconLabel.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            placeholderDot.widthAnchor.constraint(equalToConstant: 6),
            placeholderDot.heightAnchor.constraint(equalToConstant: 6),
            placeholderDot.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
            placeholderDot.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            lockView.widthAnchor.constraint(equalToConstant: 12),
            lockView.heightAnchor.constraint(equalToConstant: 12),
            previewIcon.widthAnchor.constraint(equalToConstant: 13),
            previewIcon.heightAnchor.constraint(equalToConstant: 13),
            starView.widthAnchor.constraint(equalToConstant: 12),
            starView.heightAnchor.constraint(equalToConstant: 12),
            trailing.widthAnchor.constraint(equalToConstant: 16),
        ])
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func configure(item: InboxItem, deviceName: String?, isOffline: Bool, isUnread: Bool) {
        let summary = item.summary
        accessibilityIdentifier = "inbox.thread.\(summary.id)"
        if let icon = summary.icon, !icon.isEmpty {
            iconLabel.text = icon
            iconLabel.isHidden = false
            placeholderDot.isHidden = true
        } else {
            iconLabel.isHidden = true
            placeholderDot.isHidden = false
        }
        placeholderDot.backgroundColor = .yachiyo(.textMuted)
        titleLabel.text = summary.title.isEmpty ? String(localized: "New thread") : summary.title
        titleLabel.textColor = summary.colorTag.flatMap { UIColor.yachiyoColorTag($0.rawValue) } ?? .yachiyo(.ink)
        lockView.isHidden = summary.syncOriginDeviceId == nil
        lockView.tintColor = .yachiyo(.textMuted)
        if summary.needsAttention {
            previewIcon.isHidden = false
            previewIcon.image = .lucide("message-circle-question")
            previewIcon.tintColor = .yachiyo(.accent)
            previewLabel.text = summary.preview ?? String(localized: "Waiting for your answer")
        } else if summary.isRunning {
            previewIcon.isHidden = true
            previewLabel.text = String(localized: "Working…")
        } else {
            previewIcon.isHidden = true
            previewLabel.text = summary.preview ?? " "
        }
        previewLabel.textColor = .yachiyo(.textMuted)
        deviceLabel.text = deviceName
        deviceLabel.isHidden = deviceName == nil
        deviceLabel.textColor = .yachiyo(.textPlaceholder)

        if isOffline {
            statusDot.status = .none
        } else if summary.isRunning {
            statusDot.status = .running
        } else if isUnread {
            statusDot.status = .unread
        } else {
            statusDot.status = .none
        }
        starView.isHidden = !(summary.starred && statusDot.status == .none)
        starView.tintColor = .yachiyo(.warning)
        contentView.alpha = isOffline ? 0.55 : 1

        var background = UIBackgroundConfiguration.listPlainCell()
        background.backgroundColor = .yachiyo(.app)
        backgroundConfiguration = background
    }

    override func updateConfiguration(using state: UICellConfigurationState) {
        super.updateConfiguration(using: state)
        var background = UIBackgroundConfiguration.listPlainCell().updated(for: state)
        background.backgroundColor = state.isHighlighted || state.isSelected ? YachiyoStyle.ink(0.07) : .yachiyo(.app)
        backgroundConfiguration = background
    }
}
