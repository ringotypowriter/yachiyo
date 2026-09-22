import Combine
import UIKit
import YachiyoChatUI
import YachiyoMaterial
import YachiyoRemoteKit

/// A thread: the forked message list, floating glass capsules (needs-answer, queued follow-up,
/// back to bottom), and the floating composer — or a read-only / offline banner in its place.
final class ThreadViewController: UIViewController {
    private let thread: ThreadStore
    private let store = RemoteStore.shared
    private let messageList = MessageListView()
    private let composer = ChatInputView()
    private let capsuleGroup = YachiyoMaterialKit.makeGlassGroup(spacing: 12)
    private let capsuleRow = UIStackView()
    private let needsAnswerButton = UIButton(type: .system)
    private let followUpButton = UIButton(type: .system)
    private let bottomButton = UIButton(type: .system)
    private let banner = YachiyoMaterialKit.makeFloatingSurface(cornerRadius: 22)
    private let bannerLabel = UILabel()
    private let errorLabel = UILabel()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private var cancellables: Set<AnyCancellable> = []
    private var isFollowingBottom = true

    init(desktopId: String, threadId: String) {
        thread = ThreadStore(desktopId: desktopId, threadId: threadId)
        super.init(nibName: nil, bundle: nil)
        hidesBottomBarWhenPushed = true
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .yachiyo(.canvas)
        navigationItem.largeTitleDisplayMode = .never
        configureTitle()
        configureMessageList()
        configureComposer()
        configureCapsules()
        configureBanner()
        observe()
        Task { await thread.open() }
        NotificationCenter.default.addObserver(self, selector: #selector(styleDidChange), name: YachiyoStyle.didChangeNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(true, animated: animated)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent { thread.close() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bottomChrome = view.bounds.height - min(composer.isHidden ? banner.frame.minY : composer.frame.minY, capsuleGroup.frame.minY)
        messageList.contentInsets = UIEdgeInsets(top: view.safeAreaInsets.top + 8, left: 0, bottom: bottomChrome + 12, right: 0)
    }

    @objc private func styleDidChange() {
        view.backgroundColor = .yachiyo(.canvas)
        messageList.applyYachiyoTheme()
        updateChrome()
    }

    // MARK: Setup

    private func configureTitle() {
        titleLabel.font = YachiyoFonts.navigationTitle()
        titleLabel.textAlignment = .center
        titleLabel.accessibilityIdentifier = "thread.title"
        subtitleLabel.font = YachiyoFonts.caption()
        subtitleLabel.textColor = .secondaryLabel
        subtitleLabel.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        stack.axis = .vertical
        stack.alignment = .center
        navigationItem.titleView = stack
        let menu = UIBarButtonItem(image: .lucide("ellipsis"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.makeThreadMenu() ?? [])
        }]))
        menu.accessibilityIdentifier = "thread.menu"
        menu.accessibilityLabel = String(localized: "More")
        navigationItem.rightBarButtonItem = menu
    }

    private func configureMessageList() {
        messageList.applyYachiyoTheme()
        messageList.interactionDelegate = self
        messageList.session = thread
        messageList.scrollView.accessibilityIdentifier = "thread.timeline"
        messageList.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(messageList)
        NSLayoutConstraint.activate([
            messageList.topAnchor.constraint(equalTo: view.topAnchor),
            messageList.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            messageList.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            messageList.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        YachiyoMaterialKit.applyTopEdgeEffect(to: messageList.scrollView)
    }

    private func configureComposer() {
        composer.delegate = self
        composer.placeholder = String(localized: "Message Yachiyo…")
        composer.bind(conversationID: "\(thread.desktopId)/\(thread.threadId)")
        composer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(composer)
        NSLayoutConstraint.activate([
            composer.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 2),
            composer.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -2),
            composer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        YachiyoMaterialKit.attachBottomEdge(of: messageList.scrollView, to: composer)

        errorLabel.font = YachiyoFonts.caption()
        errorLabel.textColor = .yachiyo(.dangerStrong)
        errorLabel.numberOfLines = 2
        errorLabel.accessibilityIdentifier = "thread.error"
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorLabel)
        NSLayoutConstraint.activate([
            errorLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            errorLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            errorLabel.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -2),
        ])
    }

    private func configureCapsules() {
        capsuleGroup.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(capsuleGroup)
        capsuleRow.axis = .horizontal
        capsuleRow.spacing = 8
        capsuleRow.alignment = .center
        capsuleRow.translatesAutoresizingMaskIntoConstraints = false
        capsuleGroup.contentView.addSubview(capsuleRow)
        NSLayoutConstraint.activate([
            capsuleGroup.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            capsuleGroup.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            capsuleGroup.bottomAnchor.constraint(equalTo: errorLabel.topAnchor, constant: -6),
            capsuleGroup.heightAnchor.constraint(equalToConstant: 40),
            capsuleRow.centerXAnchor.constraint(equalTo: capsuleGroup.contentView.centerXAnchor),
            capsuleRow.centerYAnchor.constraint(equalTo: capsuleGroup.contentView.centerYAnchor),
        ])
        needsAnswerButton.configuration = YachiyoMaterialKit.secondaryButtonConfiguration(title: String(localized: "Needs your answer"), image: .lucide("message-circle-question"))
        needsAnswerButton.accessibilityIdentifier = "thread.needsAnswer"
        needsAnswerButton.addAction(UIAction { [weak self] _ in
            guard let self, let question = thread.pendingQuestion else { return }
            messageList.scrollToQuestion(id: question.id)
        }, for: .touchUpInside)
        followUpButton.configuration = YachiyoMaterialKit.secondaryButtonConfiguration(title: String(localized: "Follow-up queued"), image: UIImage(systemName: "timer"))
        followUpButton.accessibilityIdentifier = "thread.followUp"
        followUpButton.showsMenuAsPrimaryAction = true
        bottomButton.configuration = YachiyoMaterialKit.secondaryButtonConfiguration(title: nil, image: UIImage(systemName: "arrow.down"))
        bottomButton.accessibilityIdentifier = "thread.scrollToBottom"
        bottomButton.accessibilityLabel = String(localized: "Scroll to bottom")
        bottomButton.addAction(UIAction { [weak self] _ in self?.messageList.scrollToBottom(animated: true) }, for: .touchUpInside)
        for button in [needsAnswerButton, followUpButton, bottomButton] {
            button.heightAnchor.constraint(equalToConstant: 36).isActive = true
            capsuleRow.addArrangedSubview(button)
        }
    }

    private func configureBanner() {
        banner.translatesAutoresizingMaskIntoConstraints = false
        banner.isHidden = true
        view.addSubview(banner)
        bannerLabel.font = YachiyoFonts.meta()
        bannerLabel.textColor = .secondaryLabel
        bannerLabel.textAlignment = .center
        bannerLabel.numberOfLines = 2
        bannerLabel.accessibilityIdentifier = "thread.banner"
        bannerLabel.translatesAutoresizingMaskIntoConstraints = false
        banner.contentView.addSubview(bannerLabel)
        NSLayoutConstraint.activate([
            banner.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            banner.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            banner.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            banner.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            bannerLabel.leadingAnchor.constraint(equalTo: banner.contentView.leadingAnchor, constant: 16),
            bannerLabel.trailingAnchor.constraint(equalTo: banner.contentView.trailingAnchor, constant: -16),
            bannerLabel.topAnchor.constraint(equalTo: banner.contentView.topAnchor, constant: 10),
            bannerLabel.bottomAnchor.constraint(equalTo: banner.contentView.bottomAnchor, constant: -10),
        ])
    }

    private func observe() {
        thread.$summary.combineLatest(thread.$detail, thread.$lastError)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateChrome() }
            .store(in: &cancellables)
        thread.messagesDidChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateChrome() }
            .store(in: &cancellables)
        store.$desktops
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateChrome() }
            .store(in: &cancellables)
    }

    // MARK: State

    private func updateChrome() {
        let summary = thread.summary
        titleLabel.text = [summary?.icon, summary?.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        titleLabel.textColor = .label
        let desktop = store.desktops.first { $0.id == thread.desktopId }
        var subtitle = [desktop?.name, summary?.workspaceName].compactMap { $0 }.joined(separator: " · ")
        if desktop?.state == .connecting { subtitle = String(localized: "Connecting…") }
        subtitleLabel.text = subtitle

        let banner: String?
        switch desktop?.state {
        case .offline:
            banner = String(localized: "\(desktop?.name ?? "") is offline")
        case .protocolMismatch:
            banner = String(localized: "Update Yachiyo on this iPhone or on \(desktop?.name ?? "") to connect.")
        default:
            banner = thread.isReadOnly ? String(localized: "Read-only — synced from another device") : nil
        }
        bannerLabel.text = banner
        self.banner.isHidden = banner == nil
        composer.isHidden = banner != nil
        composer.isRunning = thread.isRunning

        needsAnswerButton.isHidden = thread.pendingQuestion == nil
        followUpButton.isHidden = thread.queuedFollowUps.isEmpty
        followUpButton.menu = UIMenu(children: thread.queuedFollowUps.map { message in
            UIAction(title: String(localized: "Remove “\(message.content.prefix(40))”"), image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                self?.confirmRemoveFollowUp(message)
            }
        })
        bottomButton.isHidden = isFollowingBottom
        capsuleGroup.isHidden = needsAnswerButton.isHidden && followUpButton.isHidden && bottomButton.isHidden
        errorLabel.text = thread.lastError
        view.setNeedsLayout()
    }

    private func confirmRemoveFollowUp(_ message: RemoteMessage) {
        let alert = UIAlertController(title: String(localized: "Remove queued follow-up?"), message: message.content, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "Remove"), style: .destructive) { [weak self] _ in
            Task { await self?.thread.removeFollowUp(message.id) }
        })
        present(alert, animated: true)
    }

    private func makeThreadMenu() -> [UIMenuElement] {
        let starred = thread.summary?.starred ?? false
        var items: [UIMenuElement] = []
        if !thread.isReadOnly {
            items.append(UIAction(title: starred ? String(localized: "Unstar") : String(localized: "Star"), image: .lucide("star")) { [weak self] _ in
                Task { await self?.thread.setStarred(!starred) }
            })
            items.append(UIAction(title: String(localized: "Archive"), image: .lucide("archive")) { [weak self] _ in
                Task {
                    if await self?.thread.archive() == true { self?.navigationController?.popViewController(animated: true) }
                }
            })
        }
        items.append(UIAction(title: String(localized: "Copy last reply"), image: .lucide("copy")) { [weak self] _ in
            UIPasteboard.general.string = self?.thread.detail?.messages.last(where: { $0.role == .assistant })?.content
        })
        items.append(UIAction(title: String(localized: "Refresh"), image: .lucide("rotate-ccw")) { [weak self] _ in
            Task { await self?.thread.reload() }
        })
        return items
    }

    private var defaultRunningMode: SendMode {
        store.link(for: thread.desktopId)?.hello?.activeRunEnterBehavior == .enterQueuesFollowUp ? .followUp : .steer
    }
}

// MARK: - Composer

extension ThreadViewController: ChatInputDelegate {
    func chatInputDidSubmit(_: ChatInputView, object: ChatInputContent, completion: @escaping @Sendable (Bool) -> Void) {
        var mode: SendMode?
        if case let .string(raw) = object.options["mode"] { mode = SendMode(rawValue: raw) }
        if mode == nil, thread.isRunning { mode = defaultRunningMode }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            do {
                let ids = try await AttachmentUploader.upload(object.attachments, to: thread.desktopId)
                let sent = await thread.send(text: object.text, attachmentIds: ids, mode: mode)
                completion(sent)
            } catch {
                completion(false)
            }
        }
    }

    func chatInputDidRequestStop(_: ChatInputView) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task { await thread.stop() }
    }

    func chatInputDidRequestAlternateSubmit(_ input: ChatInputView) {
        guard thread.isRunning else { return }
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: String(localized: "Steer current reply"), style: .default) { _ in
            input.submit(options: ["mode": .string(SendMode.steer.rawValue)])
        })
        sheet.addAction(UIAlertAction(title: String(localized: "Queue follow-up"), style: .default) { _ in
            input.submit(options: ["mode": .string(SendMode.followUp.rawValue)])
        })
        sheet.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        sheet.popoverPresentationController?.sourceView = input
        present(sheet, animated: true)
    }

    func chatInputDidReportError(_: ChatInputView, error: String) {
        errorLabel.text = error
    }
}

// MARK: - Timeline interactions

extension ThreadViewController: MessageListInteractionDelegate {
    func messageList(_: MessageListView, answer: String, toQuestion question: QuestionContentPart) {
        Task { await thread.answer(question, with: answer) }
    }

    func messageList(_: MessageListView, plan _: String, action: PlanCardAction) {
        switch action {
        case .requestChanges:
            composer.focus()
        case .accept:
            Task { _ = await thread.acceptPlan(handoff: false) }
        case .acceptAndHandoff:
            Task {
                guard let accepted = await thread.acceptPlan(handoff: true) else { return }
                let next = ThreadViewController(desktopId: thread.desktopId, threadId: accepted.threadId)
                navigationController?.pushViewController(next, animated: true)
            }
        case .open:
            Task {
                guard let content = await thread.readPlan() else { return }
                let reader = TextSheetViewController(title: String(localized: "Execution plan"), text: content)
                present(UINavigationController(rootViewController: reader), animated: true)
            }
        }
    }

    func messageList(_: MessageListView, showSiblingOf messageId: String, offset: Int) {
        Task { await thread.showSibling(of: messageId, offset: offset) }
    }

    func messageList(_: MessageListView, didSelectToolCall toolCallId: String) {
        guard let call = thread.toolCall(toolCallId) else { return }
        let text = [call.title, call.inputPreview.map { "Input\n\($0)" }, call.outputPreview.map { "Output\n\($0)" }, call.error.map { "Error\n\($0)" }]
            .compactMap { $0 }
            .joined(separator: "\n\n")
        let detail = UINavigationController(rootViewController: TextSheetViewController(title: call.toolName, text: text))
        YachiyoMaterialKit.configureSheet(detail, detents: [.medium(), .large()])
        present(detail, animated: true)
    }

    func messageList(_: MessageListView, menuForMessage messageId: String, role: MessageRole) -> UIMenu? {
        guard let message = thread.detail?.messages.first(where: { $0.id == messageId }) else { return nil }
        var actions: [UIMenuElement] = [UIAction(title: String(localized: "Copy"), image: .lucide("copy")) { _ in
            UIPasteboard.general.string = message.content
        }]
        let capabilities = thread.summary?.capabilities
        if !thread.isRunning, !thread.isReadOnly {
            if role == .user, capabilities?.canEdit ?? false {
                actions.append(UIAction(title: String(localized: "Edit"), image: .lucide("pencil")) { [weak self] _ in self?.edit(message) })
            }
            if role == .assistant, capabilities?.canRetry ?? false {
                actions.append(UIAction(title: String(localized: "Retry"), image: .lucide("rotate-ccw")) { [weak self] _ in
                    Task { await self?.thread.retry(messageId) }
                })
            }
            if capabilities?.canCreateBranch ?? false {
                actions.append(UIAction(title: String(localized: "Branch from here"), image: .lucide("git-branch-plus")) { [weak self] _ in
                    guard let self else { return }
                    Task {
                        guard let summary = await self.thread.branch(from: messageId) else { return }
                        self.navigationController?.pushViewController(ThreadViewController(desktopId: self.thread.desktopId, threadId: summary.id), animated: true)
                    }
                })
            }
        }
        if role == .assistant {
            actions.append(UIAction(title: String(localized: "Share"), image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
                self?.present(UIActivityViewController(activityItems: [message.content], applicationActivities: nil), animated: true)
            })
        }
        return UIMenu(children: actions)
    }

    func messageList(_: MessageListView, didChangeFollowingBottom isFollowing: Bool) {
        isFollowingBottom = isFollowing
        updateChrome()
    }

    private func edit(_ message: RemoteMessage) {
        let alert = UIAlertController(
            title: String(localized: "Edit message"),
            message: String(localized: "Everything after this message will be removed."),
            preferredStyle: .alert
        )
        alert.addTextField { $0.text = message.content }
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "Send"), style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text, !text.isEmpty else { return }
            Task { await self?.thread.edit(message.id, text: text) }
        })
        present(alert, animated: true)
    }
}
