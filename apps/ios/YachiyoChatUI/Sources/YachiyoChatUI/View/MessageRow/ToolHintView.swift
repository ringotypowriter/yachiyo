import UIKit

/// The native counterpart of the desktop inline tool deck. Icon hit targets remain
/// 44 points wide rather than overlapping, so every call is reachable by touch.
final class ToolHintView: MessageListRowView {
    /// Configuration-based button titles can size to their intrinsic width even
    /// inside a narrow frame. Own both frames so arbitrary tool output cannot
    /// push the disclosure indicator (or the text) outside the timeline.
    private final class SummaryButton: UIButton {
        let summaryLabel = UILabel()
        let chevron = UIImageView()

        override init(frame: CGRect) {
            super.init(frame: frame)
            clipsToBounds = true
            isAccessibilityElement = true
            summaryLabel.numberOfLines = 2
            summaryLabel.lineBreakMode = .byTruncatingTail
            summaryLabel.clipsToBounds = true
            summaryLabel.isAccessibilityElement = false
            chevron.contentMode = .scaleAspectFit
            chevron.isAccessibilityElement = false
            addSubview(summaryLabel)
            addSubview(chevron)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        override var isHighlighted: Bool {
            didSet { alpha = isHighlighted ? 0.5 : 1 }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            let iconWidth = min(16, bounds.width)
            let textWidth = max(0, bounds.width - iconWidth - 8)
            let textHeight = min(bounds.height, ceil(summaryLabel.font.lineHeight * 2))
            let isRTL = effectiveUserInterfaceLayoutDirection == .rightToLeft
            summaryLabel.frame = CGRect(x: isRTL ? bounds.width - textWidth : 0,
                                        y: (bounds.height - textHeight) / 2,
                                        width: textWidth, height: textHeight)
            summaryLabel.preferredMaxLayoutWidth = textWidth
            chevron.frame = CGRect(x: isRTL ? 0 : bounds.width - iconWidth,
                                   y: (bounds.height - 16) / 2, width: iconWidth, height: 16)
        }
    }

    /// One call's icon. Buttons are pooled and updated in place; only visible calls get one.
    private final class CallButton: UIButton {
        struct Appearance: Equatable {
            let id: String
            let toolName: String
            let state: ToolCallState
            let isSelected: Bool
        }

        var callID: String?
        var appearance: Appearance?
    }

    private let iconContainer = UIView()
    private let overflowButton = UIButton(type: .system)
    private let summaryButton = SummaryButton(frame: .zero)
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let stateImageView = UIImageView()
    private let runningImageView = UIImageView(image: UIImage(systemName: "hourglass"))
    private let detailButton = UIButton(type: .system)
    private var calls: [ToolCallContentPart] = []
    private var selectedID: String?
    var onSelect: ((String?) -> Void)?
    var onDetails: ((String) -> Void)?
    var onToggleAll: (() -> Void)?
    private var showsAll = false
    private var callButtons: [CallButton] = []
    private var overflowAppearance: (showsAll: Bool, hiddenCount: Int)?

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

    private static var symbolImages: [String: UIImage] = [:]

    private static func symbolImage(for toolName: String) -> UIImage? {
        let name = symbol(for: toolName)
        if let image = symbolImages[name] { return image }
        let image = UIImage(systemName: name)
        symbolImages[name] = image
        return image
    }

    private static var summaryHeights: [UIContentSizeCategory: CGFloat] = [:]

    private static var summaryHeight: CGFloat {
        let category = UITraitCollection.current.preferredContentSizeCategory
        if let height = summaryHeights[category] { return height }
        let lineHeight = UIFont.preferredFont(forTextStyle: .footnote).lineHeight
        let height = max(44, ceil(lineHeight * 2) + 8)
        summaryHeights[category] = height
        return height
    }

    private static var detailConfiguration: UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        configuration.title = String(localized: "Details")
        configuration.image = UIImage(systemName: "arrow.up.right.square")
        configuration.imagePlacement = .trailing
        configuration.imagePadding = 6
        return configuration
    }

    private struct DetailWidthKey: Hashable {
        let category: UIContentSizeCategory
        let width: CGFloat
    }

    private static var detailWidths: [DetailWidthKey: CGFloat] = [:]

    /// The localized Details button width, measured once per Dynamic Type size and row width.
    private static func preferredDetailWidth(for width: CGFloat) -> CGFloat {
        let key = DetailWidthKey(category: UITraitCollection.current.preferredContentSizeCategory, width: width)
        if let cached = detailWidths[key] { return cached }
        let button = UIButton(configuration: detailConfiguration)
        let measured = max(96, button.sizeThatFits(.init(width: width, height: 44)).width)
        detailWidths[key] = measured
        return measured
    }

    /// Shared by row measurement and rendering, including the localized Details width.
    @MainActor
    private struct IconLayout {
        let columns: Int
        let iconHeight: CGFloat
        let detailFrame: CGRect
        let height: CGFloat
        let hasOverflow: Bool
        let visibleCallCount: Int

        init(width: CGFloat, callCount: Int, isExpanded: Bool, showsAll: Bool) {
            let width = max(0, width)
            let preferredDetailWidth = ToolHintView.preferredDetailWidth(for: width)
            let detailsOnOwnRow = isExpanded && width < preferredDetailWidth + 44
            let detailWidth = isExpanded ? min(width, preferredDetailWidth) : 0
            let iconWidth = detailsOnOwnRow ? width : width - detailWidth
            columns = max(1, Int(iconWidth / 44))
            hasOverflow = callCount > columns * 2
            visibleCallCount = hasOverflow && !showsAll ? max(0, columns * 2 - 1) : callCount
            let iconCount = visibleCallCount + (hasOverflow ? 1 : 0)
            let rows = max(1, (iconCount + columns - 1) / columns)
            iconHeight = CGFloat(rows) * 44
            detailFrame = CGRect(x: width - detailWidth, y: detailsOnOwnRow ? iconHeight : 0,
                                 width: detailWidth, height: 44)
            height = iconHeight + (detailsOnOwnRow ? 44 : 0)
        }
    }

    static func height(width: CGFloat, callCount: Int, isExpanded: Bool, showsAll: Bool = false) -> CGFloat {
        IconLayout(width: width, callCount: callCount, isExpanded: isExpanded, showsAll: showsAll).height + summaryHeight
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(iconContainer)
        iconContainer.addSubview(overflowButton)
        overflowButton.addAction(UIAction { [weak self] _ in self?.onToggleAll?() }, for: .touchUpInside)
        overflowButton.accessibilityIdentifier = "toolDeck.overflow"
        contentView.addSubview(summaryButton)
        contentView.addSubview(activityIndicator)
        contentView.addSubview(stateImageView)
        stateImageView.contentMode = .scaleAspectFit
        stateImageView.isAccessibilityElement = false
        activityIndicator.isAccessibilityElement = false
        contentView.addSubview(runningImageView)
        runningImageView.contentMode = .scaleAspectFit
        runningImageView.tintColor = .secondaryLabel
        runningImageView.isAccessibilityElement = false
        contentView.addSubview(detailButton)
        summaryButton.contentHorizontalAlignment = .leading
        summaryButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            onSelect?(selectedID == nil ? Self.summaryCall(in: calls)?.id : nil)
        }, for: .touchUpInside)
        detailButton.configuration = Self.detailConfiguration
        detailButton.addAction(UIAction { [weak self] _ in
            guard let self, let selectedID else { return }
            onDetails?(selectedID)
        }, for: .touchUpInside)
    }

    func configure(calls: [ToolCallContentPart], selectedID: String?, showsAll: Bool = false) {
        self.calls = calls
        self.selectedID = selectedID
        self.showsAll = showsAll
        summaryButton.accessibilityIdentifier = calls.first.map { "toolDeck.summary.\($0.id)" }
        detailButton.accessibilityIdentifier = calls.first.map { "toolDeck.details.\($0.id)" }
        let selected = calls.first(where: { $0.id == selectedID })
        let displayed = selected ?? Self.summaryCall(in: calls)
        let title = displayed.map { call in
            // The remote adapter stores the human-readable call title in parameters.
            let title = call.parameters.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            return title.isEmpty || title == "{}" ? call.toolName : title
        }
        summaryButton.summaryLabel.text = title
        summaryButton.summaryLabel.font = UIFont.preferredFont(forTextStyle: .footnote)
        summaryButton.summaryLabel.textColor = displayed?.state == .failed ? .systemRed : .label
        summaryButton.summaryLabel.accessibilityIdentifier = "toolDeck.summaryText"
        summaryButton.chevron.image = UIImage(systemName: selected == nil ? "chevron.down" : "chevron.up")
        summaryButton.chevron.tintColor = summaryButton.summaryLabel.textColor
        summaryButton.chevron.accessibilityIdentifier = "toolDeck.summaryChevron"
        summaryButton.setNeedsLayout()
        let importantCalls = calls.filter { $0.id != displayed?.id && $0.state != .succeeded }
        summaryButton.accessibilityLabel = ([title, displayed.map { statusText(for: $0) }]
            .compactMap { $0 } + importantCalls.map { statusText(for: $0) }).joined(separator: ". ")
        summaryButton.accessibilityValue = selected == nil ? String(localized: "Collapsed") : String(localized: "Expanded")
        let isRunning = calls.contains { $0.state == .running }
        let hasFailure = calls.contains { $0.state == .failed }
        if isRunning && !UIAccessibility.isReduceMotionEnabled {
            activityIndicator.startAnimating()
        } else {
            activityIndicator.stopAnimating()
        }
        runningImageView.isHidden = !isRunning || !UIAccessibility.isReduceMotionEnabled
        stateImageView.isHidden = isRunning && !hasFailure
        stateImageView.image = UIImage(systemName: hasFailure ? "exclamationmark.circle" : "checkmark.circle")
        stateImageView.tintColor = hasFailure ? .systemRed : .secondaryLabel
        stateImageView.accessibilityIdentifier = calls.first.map { "toolDeck.status.\($0.id)" }
        activityIndicator.accessibilityIdentifier = calls.first.map { "toolDeck.activity.\($0.id)" }
        runningImageView.accessibilityIdentifier = calls.first.map { "toolDeck.running.\($0.id)" }
        detailButton.isHidden = selected == nil
        detailButton.isEnabled = selected?.state != .running
        detailButton.accessibilityLabel = String(localized: "Details")
        // Buttons exist right after configure (hit-testing, accessibility), sized for the current
        // width; layout re-syncs if the width changes the number of visible calls.
        syncCallButtons(layout: currentIconLayout())
        setNeedsContentLayout()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        onSelect = nil
        onDetails = nil
        onToggleAll = nil
        activityIndicator.stopAnimating()
    }

    private func statusText(for call: ToolCallContentPart) -> String {
        switch call.state {
        case .running: String.localized("Tool call for \(call.toolName) running")
        case .succeeded: String.localized("Tool call for \(call.toolName) completed.")
        case .failed: String.localized("Tool call for \(call.toolName) failed.")
        }
    }

    private func currentIconLayout() -> IconLayout {
        IconLayout(width: contentView.bounds.width, callCount: calls.count, isExpanded: !detailButton.isHidden, showsAll: showsAll)
    }

    /// The visible calls are the most recent ones; earlier calls sit behind the overflow button.
    private func syncCallButtons(layout: IconLayout) {
        let visibleCalls = calls.suffix(layout.visibleCallCount)
        while callButtons.count < visibleCalls.count {
            let button = CallButton(type: .system)
            button.addAction(UIAction { [weak self, weak button] _ in
                guard let self, let callID = button?.callID else { return }
                onSelect?(selectedID == callID ? nil : callID)
            }, for: .touchUpInside)
            iconContainer.addSubview(button)
            callButtons.append(button)
        }
        for (index, button) in callButtons.enumerated() {
            guard index < visibleCalls.count else {
                button.isHidden = true
                button.callID = nil
                button.appearance = nil
                button.accessibilityIdentifier = nil
                continue
            }
            let call = visibleCalls[visibleCalls.startIndex + index]
            button.isHidden = false
            button.callID = call.id
            let appearance = CallButton.Appearance(id: call.id, toolName: call.toolName, state: call.state, isSelected: call.id == selectedID)
            guard button.appearance != appearance else { continue }
            button.appearance = appearance
            var configuration = UIButton.Configuration.plain()
            configuration.image = Self.symbolImage(for: call.toolName)
            configuration.preferredSymbolConfigurationForImage = .init(pointSize: 14, weight: .medium)
            configuration.background.backgroundColor = appearance.isSelected ? .tintColor.withAlphaComponent(0.12) : .tertiarySystemFill
            configuration.background.cornerRadius = 14
            configuration.background.backgroundInsets = .init(top: 8, leading: 8, bottom: 8, trailing: 8)
            configuration.baseForegroundColor = call.state == .failed ? .systemRed : (call.state == .running ? .tintColor : .secondaryLabel)
            button.configuration = configuration
            button.accessibilityLabel = statusText(for: call)
            button.accessibilityIdentifier = "toolDeck.call.\(call.id)"
            button.accessibilityTraits = appearance.isSelected ? [.button, .selected] : .button
        }
    }

    private func updateOverflowButton(hiddenCount: Int) {
        let appearance = (showsAll: showsAll, hiddenCount: hiddenCount)
        if let current = overflowAppearance, current == appearance { return }
        overflowAppearance = appearance
        var configuration = UIButton.Configuration.plain()
        configuration.title = showsAll ? nil : "+\(hiddenCount)"
        configuration.titleLineBreakMode = .byClipping
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = .systemFont(ofSize: 12, weight: .medium)
            return attributes
        }
        configuration.contentInsets = .zero
        configuration.image = showsAll ? UIImage(systemName: "chevron.up") : nil
        configuration.preferredSymbolConfigurationForImage = .init(pointSize: 13, weight: .medium)
        configuration.background.backgroundColor = .tertiarySystemFill
        configuration.background.cornerRadius = 14
        configuration.background.backgroundInsets = .init(top: 8, leading: 8, bottom: 8, trailing: 8)
        configuration.baseForegroundColor = .secondaryLabel
        overflowButton.configuration = configuration
        overflowButton.accessibilityLabel = showsAll ? String(localized: "Show fewer tool calls") : String(localized: "Show \(hiddenCount) earlier tool calls")
    }

    override func layoutContent() {
        let width = contentView.bounds.width
        let layout = currentIconLayout()
        let summaryHeight = Self.summaryHeight
        iconContainer.frame = CGRect(x: 0, y: 0, width: width, height: layout.iconHeight)
        syncCallButtons(layout: layout)
        let leadingSlots = layout.hasOverflow && !showsAll ? 1 : 0
        for (index, button) in callButtons.enumerated() where !button.isHidden {
            let position = index + leadingSlots
            button.frame = CGRect(x: CGFloat(position % layout.columns) * 44,
                                  y: CGFloat(position / layout.columns) * 44, width: 44, height: 44)
        }
        overflowButton.isHidden = !layout.hasOverflow
        if layout.hasOverflow {
            updateOverflowButton(hiddenCount: calls.count - layout.visibleCallCount)
            let position = showsAll ? calls.count : 0
            overflowButton.frame = CGRect(x: CGFloat(position % layout.columns) * 44,
                                          y: CGFloat(position / layout.columns) * 44, width: 44, height: 44)
        }
        detailButton.frame = layout.detailFrame
        let showsBothStates = calls.contains { $0.state == .running } && calls.contains { $0.state == .failed }
        activityIndicator.frame = CGRect(x: 0, y: layout.height + (summaryHeight - 20) / 2, width: 20, height: 20)
        runningImageView.frame = activityIndicator.frame.insetBy(dx: 2, dy: 2)
        stateImageView.frame = activityIndicator.frame.offsetBy(dx: showsBothStates ? 20 : 0, dy: 0).insetBy(dx: 2, dy: 2)
        let summaryX: CGFloat = showsBothStates ? 48 : 28
        summaryButton.frame = CGRect(x: summaryX, y: layout.height, width: max(0, width - summaryX), height: summaryHeight)
    }
}
