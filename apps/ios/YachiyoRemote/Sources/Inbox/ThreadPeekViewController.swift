import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// The long-press preview of an inbox thread: its newest saved messages, read from this iPhone's
/// cache. Peeking is read-only: it neither opens the thread on the Mac (no watch scope) nor marks
/// it read, so cancelling leaves the inbox exactly as it was.
final class ThreadPeekViewController: UIViewController {
    private static let messageLimit = 6
    private static let maximumHeight: CGFloat = 420

    private let summary: RemoteThreadSummary
    private let desktopId: String
    private let stack = UIStackView()
    private var loadTask: Task<Void, Never>?

    init(desktopId: String, summary: RemoteThreadSummary) {
        self.desktopId = desktopId
        self.summary = summary
        super.init(nibName: nil, bundle: nil)
        preferredContentSize = CGSize(width: 0, height: Self.maximumHeight)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    deinit { loadTask?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .yachiyo(.canvas)
        view.accessibilityIdentifier = "inbox.peek"
        stack.axis = .vertical
        stack.spacing = 10
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            // The newest messages sit at the bottom, as in the thread; older ones clip at the top.
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            stack.topAnchor.constraint(greaterThanOrEqualTo: view.topAnchor, constant: 16),
        ])
        view.clipsToBounds = true
        show(messages: nil)
        let (desktopId, threadId) = (desktopId, summary.id)
        loadTask = Task { [weak self] in
            let cached = await RemoteStore.shared.cachedThread(desktopId: desktopId, threadId: threadId)
            guard let self, !Task.isCancelled else { return }
            show(messages: cached?.detail.messages)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Hug short histories; longer ones clip their oldest messages at the top.
        let fitting = stack.systemLayoutSizeFitting(
            CGSize(width: view.bounds.width - 32, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel
        )
        let height = min(ceil(fitting.height) + 32, Self.maximumHeight)
        if abs(preferredContentSize.height - height) > 0.5 { preferredContentSize = CGSize(width: 0, height: height) }
    }

    private func show(messages: [RemoteMessage]?) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let title = UILabel()
        title.font = YachiyoFonts.cardTitleStrong()
        title.textColor = .yachiyo(.ink)
        title.text = [summary.icon, summary.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        title.numberOfLines = 2
        stack.addArrangedSubview(title)
        let recent = (messages ?? []).filter { !$0.content.isEmpty }.suffix(Self.messageLimit)
        guard !recent.isEmpty else {
            // Without saved history the inbox preview line is all this iPhone knows.
            stack.addArrangedSubview(label(summary.preview ?? String(localized: "No saved history on this iPhone yet."), role: nil))
            return
        }
        for message in recent { stack.addArrangedSubview(label(message.content, role: message.role)) }
    }

    private func label(_ text: String, role: Role?) -> UIView {
        let label = UILabel()
        label.text = text
        label.numberOfLines = role == .user ? 3 : 6
        label.font = role == nil ? YachiyoFonts.meta() : YachiyoFonts.preview()
        label.textColor = role == nil ? .yachiyo(.textSecondary) : .yachiyo(.ink)
        guard role == .user else { return label }
        // User messages keep the thread's trailing bubble so speakers stay distinguishable.
        let bubble = UIView()
        bubble.backgroundColor = UIColor.yachiyo(.accent).withAlphaComponent(0.14)
        bubble.layer.cornerRadius = 10
        bubble.layer.cornerCurve = .continuous
        label.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(label)
        let row = UIView()
        bubble.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(bubble)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 8),
            label.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -8),
            label.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -10),
            bubble.topAnchor.constraint(equalTo: row.topAnchor),
            bubble.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            bubble.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            bubble.leadingAnchor.constraint(greaterThanOrEqualTo: row.leadingAnchor, constant: 48),
        ])
        return row
    }
}
