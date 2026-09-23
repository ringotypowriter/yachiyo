import UIKit

/// The native counterpart of the desktop inline tool deck. Icon hit targets remain
/// 44 points wide rather than overlapping, so every call is reachable by touch.
final class ToolHintView: MessageListRowView {
    private let iconScrollView = UIScrollView()
    private let iconStack = UIStackView()
    private let summaryButton = UIButton(type: .system)
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let stateImageView = UIImageView()
    private let detailView = UIView()
    private let previewLabel = UILabel()
    private let statusLabel = UILabel()
    private let detailButton = UIButton(type: .system)
    private var calls: [ToolCallContentPart] = []
    private var selectedID: String?
    var onSelect: ((String?) -> Void)?
    var onDetails: ((String) -> Void)?

    static func summaryCall(in calls: [ToolCallContentPart]) -> ToolCallContentPart? {
        calls.last(where: { $0.state == .running }) ?? calls.last
    }

    static func symbol(for name: String) -> String {
        switch name {
        case "read": "eye"
        case "write": "doc.badge.plus"
        case "edit": "pencil"
        case "bash": "terminal"
        case "jsRepl", "pyRepl": "chevron.left.forwardslash.chevron.right"
        case "grep": "doc.text.magnifyingglass"
        case "glob": "folder"
        case "webRead": "newspaper"
        case "useBrowser": "macwindow"
        case "webSearch": "globe"
        case "skillsRead": "book.closed"
        case "applyPatch": "plus.forwardslash.minus"
        case "useSentinel": "dot.radiowaves.left.and.right"
        case "askUser": "questionmark.bubble"
        case "delegateTask": "point.3.connected.trianglepath.dotted"
        case "remember": "brain"
        case "querySource": "externaldrive"
        case "useThings": "shippingbox"
        case "reviewThings": "list.clipboard"
        case "updateProfile": "person.crop.circle"
        case "updateTodoList": "checklist"
        case "sendThreadMessage": "bubble.left.and.bubble.right"
        case "steerTask": "paperplane"
        case "getTask": "list.clipboard"
        case "exitPlanMode": "door.left.hand.open"
        default: "wrench.and.screwdriver"
        }
    }

    static func height(isExpanded: Bool) -> CGFloat {
        let lineHeight = UIFont.preferredFont(forTextStyle: .footnote).lineHeight
        return 44 + max(44, lineHeight + 20) + (isExpanded ? ceil(lineHeight * 3) + 68 : 0)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        iconScrollView.showsHorizontalScrollIndicator = false
        iconScrollView.addSubview(iconStack)
        iconStack.axis = .horizontal
        contentView.addSubview(iconScrollView)
        contentView.addSubview(summaryButton)
        contentView.addSubview(activityIndicator)
        contentView.addSubview(stateImageView)
        stateImageView.contentMode = .scaleAspectFit
        stateImageView.isAccessibilityElement = false
        activityIndicator.isAccessibilityElement = false
        contentView.addSubview(detailView)
        detailView.backgroundColor = .secondarySystemBackground
        detailView.layer.cornerRadius = 14
        detailView.layer.cornerCurve = .continuous
        detailView.addSubview(previewLabel)
        detailView.addSubview(statusLabel)
        detailView.addSubview(detailButton)
        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = .secondaryLabel
        previewLabel.numberOfLines = 3
        previewLabel.lineBreakMode = .byTruncatingTail
        previewLabel.textColor = .secondaryLabel
        previewLabel.adjustsFontForContentSizeCategory = true
        summaryButton.contentHorizontalAlignment = .leading
        summaryButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            onSelect?(selectedID == nil ? Self.summaryCall(in: calls)?.id : nil)
        }, for: .touchUpInside)
        var detailConfiguration = UIButton.Configuration.plain()
        detailConfiguration.title = String(localized: "Details")
        detailConfiguration.image = UIImage(systemName: "arrow.up.right.square")
        detailConfiguration.imagePlacement = .trailing
        detailConfiguration.imagePadding = 6
        detailButton.configuration = detailConfiguration
        detailButton.addAction(UIAction { [weak self] _ in
            guard let self, let selectedID else { return }
            onDetails?(selectedID)
        }, for: .touchUpInside)
    }

    func configure(calls: [ToolCallContentPart], selectedID: String?) {
        self.calls = calls
        self.selectedID = selectedID
        summaryButton.accessibilityIdentifier = calls.first.map { "toolDeck.summary.\($0.id)" }
        detailButton.accessibilityIdentifier = calls.first.map { "toolDeck.details.\($0.id)" }
        let selected = calls.first(where: { $0.id == selectedID })
        let displayed = selected ?? Self.summaryCall(in: calls)
        for view in iconStack.arrangedSubviews {
            iconStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for call in calls {
            let button = UIButton(type: .system)
            var configuration = UIButton.Configuration.plain()
            configuration.image = UIImage(systemName: Self.symbol(for: call.toolName))
            configuration.preferredSymbolConfigurationForImage = .init(pointSize: 14, weight: .medium)
            configuration.background.backgroundColor = call.id == selectedID ? .tintColor.withAlphaComponent(0.12) : .tertiarySystemFill
            configuration.background.cornerRadius = 14
            configuration.background.backgroundInsets = .init(top: 8, leading: 8, bottom: 8, trailing: 8)
            configuration.baseForegroundColor = call.state == .failed ? .systemRed : (call.state == .running ? .tintColor : .secondaryLabel)
            button.configuration = configuration
            button.widthAnchor.constraint(equalToConstant: 44).isActive = true
            button.accessibilityLabel = statusText(for: call)
            button.accessibilityIdentifier = "toolDeck.call.\(call.id)"
            button.accessibilityTraits = call.id == selectedID ? [.button, .selected] : .button
            button.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                onSelect?(self.selectedID == call.id ? nil : call.id)
            }, for: .touchUpInside)
            iconStack.addArrangedSubview(button)
        }
        var configuration = UIButton.Configuration.plain()
        configuration.title = displayed.map { call in
            let preview = call.parameters.replacingOccurrences(of: "\n", with: " ")
            return preview.isEmpty || preview == "{}" ? call.toolName : "\(call.toolName) · \(preview)"
        }
        configuration.image = UIImage(systemName: selected == nil ? "chevron.down" : "chevron.up")
        configuration.imagePlacement = .trailing
        configuration.imagePadding = 8
        configuration.contentInsets = .zero
        configuration.baseForegroundColor = displayed?.state == .failed ? .systemRed : .secondaryLabel
        configuration.titleTextAttributesTransformer = .init { attributes in
            var attributes = attributes
            attributes.font = UIFont.preferredFont(forTextStyle: .footnote)
            return attributes
        }
        summaryButton.configuration = configuration
        summaryButton.titleLabel?.numberOfLines = 1
        summaryButton.titleLabel?.lineBreakMode = .byTruncatingTail
        summaryButton.accessibilityLabel = displayed.map { statusText(for: $0) }
        summaryButton.accessibilityValue = selected == nil ? String(localized: "Collapsed") : String(localized: "Expanded")
        let isRunning = displayed?.state == .running
        if isRunning && !UIAccessibility.isReduceMotionEnabled {
            activityIndicator.startAnimating()
        } else {
            activityIndicator.stopAnimating()
        }
        stateImageView.isHidden = isRunning && !UIAccessibility.isReduceMotionEnabled
        stateImageView.image = UIImage(systemName: isRunning ? "hourglass" : (displayed?.state == .failed ? "exclamationmark.circle" : "checkmark.circle"))
        stateImageView.tintColor = displayed?.state == .failed ? .systemRed : .secondaryLabel
        detailView.isHidden = selected == nil
        previewLabel.text = selected?.parameters
        previewLabel.font = .preferredFont(forTextStyle: .footnote)
        detailButton.isEnabled = selected?.state != .running
        detailButton.accessibilityLabel = String(localized: "Details")
        statusLabel.text = selected.map { statusText(for: $0) }
        setNeedsLayout()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        onSelect = nil
        onDetails = nil
        iconScrollView.contentOffset = .zero
        activityIndicator.stopAnimating()
    }

    private func statusText(for call: ToolCallContentPart) -> String {
        switch call.state {
        case .running: String.localized("Tool call for \(call.toolName) running")
        case .succeeded: String.localized("Tool call for \(call.toolName) completed.")
        case .failed: String.localized("Tool call for \(call.toolName) failed.")
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        let summaryHeight = max(44, UIFont.preferredFont(forTextStyle: .footnote).lineHeight + 20)
        iconScrollView.frame = CGRect(x: 0, y: 0, width: width, height: 44)
        iconStack.frame = CGRect(x: 0, y: 0, width: CGFloat(calls.count) * 44, height: 44)
        iconScrollView.contentSize = iconStack.bounds.size
        activityIndicator.frame = CGRect(x: 0, y: 44 + (summaryHeight - 20) / 2, width: 20, height: 20)
        stateImageView.frame = activityIndicator.frame.insetBy(dx: 2, dy: 2)
        summaryButton.frame = CGRect(x: 28, y: 44, width: max(0, width - 28), height: summaryHeight)
        detailView.frame = CGRect(x: 0, y: 44 + summaryHeight, width: width, height: max(0, contentView.bounds.height - 44 - summaryHeight))
        previewLabel.frame = CGRect(x: 12, y: 12, width: max(0, width - 24), height: ceil(previewLabel.font.lineHeight * 3))
        let detailWidth = min(width, max(100, detailButton.sizeThatFits(.init(width: width, height: 44)).width))
        detailButton.frame = CGRect(x: width - detailWidth, y: previewLabel.frame.maxY + 4, width: detailWidth, height: 44)
        statusLabel.frame = CGRect(x: 12, y: detailButton.frame.minY, width: max(0, width - detailWidth - 20), height: 44)
    }
}
