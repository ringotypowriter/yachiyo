import Combine
import UIKit
import YachiyoChatUI
import YachiyoMaterial
import YachiyoRemoteKit

/// A thread: the forked message list, floating glass capsules (needs-answer, queued follow-up,
/// back to bottom), and the floating composer — or a read-only banner for a genuinely read-only source.
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
    private let deliverySpinner = UIActivityIndicatorView(style: .medium)
    private let loadingStatus = UIStackView()
    private let loadingLabel = UILabel()
    private let emptyHistoryLabel = UILabel()
    private let loadingSpinner = UIActivityIndicatorView(style: .medium)
    private let retryButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private var cancellables: Set<AnyCancellable> = []
    private var isFollowingBottom = true
    private var localError: String?
    private struct CachedDraft {
        let content: ChatInputContent
        let revision: UUID
    }
    private static var drafts: [String: CachedDraft] = [:]
    private var draftRevision: UUID?
    private var draftKey: String { "\(thread.desktopId)/\(thread.threadId)" }
    private var stopRequested = false
    private var answeringQuestions: Set<String> = []
    private var isAcceptingPlan = false
    private var isSwitchingBranch = false
    private var isOpeningPlan = false

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
        configureLoadingStatus()
        observe()
        NotificationCenter.default.addObserver(self, selector: #selector(styleDidChange), name: YachiyoStyle.didChangeNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(true, animated: animated)
        Task { await thread.open() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if presentedViewController == nil { thread.close() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bottomChrome = view.bounds.height - min(composer.isHidden ? banner.frame.minY : composer.frame.minY, capsuleGroup.frame.minY)
        messageList.contentInsets = UIEdgeInsets(top: 8, left: 0, bottom: bottomChrome + 12, right: 0)
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
        let stack = UIStackView(arrangedSubviews: [titleLabel, loadingStatus])
        stack.axis = .vertical
        stack.alignment = .center
        stack.widthAnchor.constraint(equalToConstant: 230).isActive = true
        titleLabel.lineBreakMode = .byTruncatingTail
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
        messageList.clipsToBounds = true
        messageList.scrollView.accessibilityIdentifier = "thread.timeline"
        messageList.scrollView.keyboardDismissMode = .interactive
        messageList.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(messageList)
        NSLayoutConstraint.activate([
            messageList.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            messageList.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            messageList.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            messageList.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        emptyHistoryLabel.font = YachiyoFonts.meta()
        emptyHistoryLabel.textColor = .secondaryLabel
        emptyHistoryLabel.textAlignment = .center
        emptyHistoryLabel.numberOfLines = 0
        emptyHistoryLabel.isUserInteractionEnabled = false
        emptyHistoryLabel.accessibilityIdentifier = "thread.emptyHistory"
        emptyHistoryLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(emptyHistoryLabel)
        NSLayoutConstraint.activate([
            emptyHistoryLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32),
            emptyHistoryLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            emptyHistoryLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
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
        errorLabel.isUserInteractionEnabled = false
        errorLabel.accessibilityIdentifier = "thread.error"
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorLabel)
        deliverySpinner.translatesAutoresizingMaskIntoConstraints = false
        deliverySpinner.isUserInteractionEnabled = false
        deliverySpinner.accessibilityIdentifier = "thread.deliveryProgress"
        view.addSubview(deliverySpinner)
        NSLayoutConstraint.activate([
            deliverySpinner.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            deliverySpinner.centerYAnchor.constraint(equalTo: errorLabel.centerYAnchor),
            deliverySpinner.widthAnchor.constraint(equalToConstant: 20),
            errorLabel.heightAnchor.constraint(equalToConstant: 32),
            errorLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 44),
            errorLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            errorLabel.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -2),
        ])
    }

    private func configureCapsules() {
        capsuleGroup.isHidden = true
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
            capsuleGroup.heightAnchor.constraint(equalToConstant: 44),
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
            button.heightAnchor.constraint(equalToConstant: 44).isActive = true
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
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

    private func configureLoadingStatus() {
        // Status lives in the navigation bar, never over the scrollable history. Its
        // reserved height stays constant while connecting, refreshing, or retrying.
        loadingStatus.axis = .horizontal
        loadingStatus.spacing = 4
        loadingStatus.alignment = .center
        loadingLabel.font = YachiyoFonts.caption()
        loadingLabel.textColor = .secondaryLabel
        loadingLabel.numberOfLines = 1
        loadingLabel.lineBreakMode = .byTruncatingTail
        loadingLabel.accessibilityIdentifier = "thread.loadingStatus"
        loadingLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        loadingSpinner.isUserInteractionEnabled = false
        retryButton.titleLabel?.font = YachiyoFonts.caption()
        retryButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        retryButton.setTitle(String(localized: "Retry"), for: .normal)
        retryButton.accessibilityIdentifier = "thread.retryLoad"
        retryButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            if store.link(for: thread.desktopId)?.state == .online { Task { await self.thread.reload() } }
            else { store.retryConnection(desktopId: thread.desktopId) }
        }, for: .touchUpInside)
        for child in [loadingSpinner, loadingLabel, retryButton] { loadingStatus.addArrangedSubview(child) }
        NSLayoutConstraint.activate([
            loadingStatus.heightAnchor.constraint(equalToConstant: 22),
            loadingStatus.widthAnchor.constraint(lessThanOrEqualToConstant: 230),
        ])
    }

    private func observe() {
        thread.$outboundState.combineLatest(thread.$replyState)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateChrome() }
            .store(in: &cancellables)
        thread.$isLoading.combineLatest(thread.$loadError, thread.$isStopping)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateChrome() }
            .store(in: &cancellables)
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
        subtitleLabel.text = [desktop?.name, summary?.workspaceName].compactMap { $0 }.joined(separator: " · ")

        let connection = desktop.flatMap { store.connectionText(for: $0) }
        let busy = desktop?.state == .connecting || (desktop?.state == .online && thread.isLoading) || thread.isStopping
        let status = connection ?? (thread.isStopping ? String(localized: "Stopping response…") : (thread.isLoading ? (thread.detail == nil ? String(localized: "Loading history…") : String(localized: "Refreshing…")) : thread.loadError.map { String(localized: "Couldn't load conversation. \($0)") }))
        emptyHistoryLabel.isHidden = thread.detail != nil || !thread.messages.isEmpty
        emptyHistoryLabel.text = desktop?.state == .online
            ? (thread.loadError == nil ? String(localized: "Loading conversation history…") : String(localized: "History couldn't be loaded. Tap Retry above."))
            : String(localized: "No saved history on this iPhone yet. History will load when your Mac connects.")
        loadingLabel.text = status ?? subtitleLabel.text
        loadingLabel.accessibilityLabel = status ?? subtitleLabel.text
        loadingSpinner.isHidden = !busy
        if busy { loadingSpinner.startAnimating() } else { loadingSpinner.stopAnimating() }
        let offline: Bool
        if case .offline = desktop?.state { offline = true } else { offline = false }
        retryButton.isHidden = busy || !(offline || (desktop?.state == .online && thread.loadError != nil))
        bannerLabel.text = thread.isReadOnly ? String(localized: "Read-only — synced from another device") : nil
        banner.isHidden = !thread.isReadOnly
        // Keep the draft and keyboard in place during transient connection/refresh states.
        if thread.isReadOnly { composer.endEditing(true) }
        composer.isHidden = thread.isReadOnly
        composer.isRunning = thread.isRunning
        composer.isStopping = stopRequested || thread.isStopping

        needsAnswerButton.isHidden = thread.pendingQuestion == nil
        followUpButton.isHidden = thread.queuedFollowUps.isEmpty
        followUpButton.menu = UIMenu(children: thread.queuedFollowUps.map { message in
            UIAction(title: String(localized: "Remove “\(message.content.prefix(40))”"), image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                self?.confirmRemoveFollowUp(message)
            }
        })
        bottomButton.isHidden = isFollowingBottom
        capsuleGroup.isHidden = needsAnswerButton.isHidden && followUpButton.isHidden && bottomButton.isHidden
        let error = localError ?? thread.lastError
        errorLabel.text = error ?? deliveryStatus
        errorLabel.textColor = error == nil ? .secondaryLabel : .yachiyo(.dangerStrong)
        errorLabel.accessibilityIdentifier = error == nil ? "thread.deliveryStatus" : "thread.error"
        if thread.isSending { deliverySpinner.startAnimating() } else { deliverySpinner.stopAnimating() }
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
        if !thread.isReadOnly, store.link(for: thread.desktopId)?.state == .online {
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
            guard let self else { return }
            if store.link(for: thread.desktopId)?.state == .online { Task { await self.thread.reload() } }
            else { store.retryConnection(desktopId: thread.desktopId) }
        })
        return items
    }

    private var deliveryStatus: String? {
        switch thread.outboundState {
        case .uploading: return String(localized: "Uploading attachments…")
        case .sending: return String(localized: "Sending to your Mac…")
        case .unconfirmed: return String(localized: "Delivery unconfirmed. Check history before sending again.")
        case .rejected: return String(localized: "Not sent. Your draft is kept.")
        case .offline: return String(localized: "Offline — your draft is kept. Nothing is queued to send.")
        case .queued: return String(localized: "Message queued on your Mac.")
        case .idle, .accepted: break
        }
        if thread.replyState != .idle, store.link(for: thread.desktopId)?.state != .online {
            return String(localized: "Sent — reconnect to check the reply.")
        }
        // Waiting for a reply is not the same as an in-flight send RPC.
        switch thread.replyState {
        case .waiting: return String(localized: "Sent — waiting for Yachiyo…")
        case .responding: return String(localized: "Yachiyo is responding…")
        case .idle: return thread.outboundState == .accepted ? String(localized: "Sent to your Mac") : nil
        }
    }

    private var defaultRunningMode: SendMode {
        store.link(for: thread.desktopId)?.hello?.activeRunEnterBehavior == .enterQueuesFollowUp ? .followUp : .steer
    }
}

// MARK: - Composer

extension ThreadViewController: ChatInputDelegate {
    func chatInputDidUpdateObject(_ input: ChatInputView, object: ChatInputContent) {
        if object.hasEmptyContent {
            // A late reset from an older composer must not clear a newer controller's draft.
            if Self.drafts[draftKey]?.revision == draftRevision {
                Self.drafts[draftKey] = nil
                draftRevision = nil
            }
            return
        }
        let previous = Self.drafts[draftKey]
        let unchanged = previous?.content.text == object.text && previous?.content.attachments == object.attachments
        let revision = unchanged ? (previous?.revision ?? UUID()) : UUID()
        Self.drafts[draftKey] = CachedDraft(content: object, revision: revision)
        draftRevision = revision
    }

    func chatInputDidRequestObjectForRestore(_: ChatInputView) -> ChatInputContent? {
        draftRevision = Self.drafts[draftKey]?.revision
        return Self.drafts[draftKey]?.content
    }

    func chatInputDidSubmit(_: ChatInputView, object: ChatInputContent, completion: @escaping @Sendable (Bool) -> Void) {
        // Reject before uploading attachments. A failed submit keeps the bound draft;
        // reconnecting never schedules a send or replays this action.
        guard !thread.isReadOnly, store.link(for: thread.desktopId)?.state == .online else {
            localError = thread.isReadOnly
                ? String(localized: "This conversation is read-only.")
                : String(localized: "Connect to your Mac to send. Your draft is kept.")
            updateChrome()
            completion(false)
            return
        }
        localError = nil
        guard thread.beginUpload() else {
            updateChrome()
            completion(false)
            return
        }
        var mode: SendMode?
        if case let .string(raw) = object.options["mode"] { mode = SendMode(rawValue: raw) }
        if mode == nil, thread.isRunning { mode = defaultRunningMode }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let submittedRevision = Self.drafts[draftKey]?.revision
        Task {
            do {
                let ids = try await AttachmentUploader.upload(object.attachments, to: thread.desktopId)
                let sent = await thread.send(text: object.text, attachmentIds: ids, mode: mode, attachments: object.attachments)
                // Retire the cached draft before the weak composer completion is scheduled:
                // the screen may already have been popped and its composer can deallocate.
                if sent, let submittedRevision, Self.drafts[draftKey]?.revision == submittedRevision {
                    Self.drafts[draftKey] = nil
                    draftRevision = nil
                }
                completion(sent)
            } catch {
                thread.failUpload(error)
                updateChrome()
                completion(false)
            }
        }
    }

    func chatInputDidRequestStop(_: ChatInputView) {
        guard thread.isRunning, !stopRequested, !thread.isStopping else { return }
        stopRequested = true
        localError = nil
        updateChrome()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            defer { stopRequested = false; updateChrome() }
            await thread.stop()
        }
    }

    func chatInputDidRequestAlternateSubmit(_ input: ChatInputView) {
        guard thread.isRunning, !input.isSubmitting, presentedViewController == nil else { return }
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: String(localized: "Steer current reply"), style: .default) { _ in
            input.submit(options: ["mode": .string(SendMode.steer.rawValue)])
        })
        sheet.addAction(UIAlertAction(title: String(localized: "Queue follow-up"), style: .default) { _ in
            input.submit(options: ["mode": .string(SendMode.followUp.rawValue)])
        })
        sheet.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        sheet.popoverPresentationController?.sourceView = input
        sheet.popoverPresentationController?.sourceRect = input.bounds
        present(sheet, animated: true)
    }

    func chatInputDidReportError(_: ChatInputView, error: String) {
        localError = error
        updateChrome()
    }
}

// MARK: - Timeline interactions

extension ThreadViewController: MessageListInteractionDelegate {
    func messageList(_: MessageListView, answer: String, toQuestion question: QuestionContentPart) {
        guard answeringQuestions.insert(question.id).inserted else { return }
        localError = nil
        Task {
            defer { answeringQuestions.remove(question.id); updateChrome() }
            await thread.answer(question, with: answer)
        }
    }

    func messageList(_: MessageListView, plan messageId: String, action: PlanCardAction) {
        switch action {
        case .requestChanges:
            composer.focus()
        case .accept:
            guard !isAcceptingPlan else { return }
            isAcceptingPlan = true
            localError = nil
            Task {
                defer { isAcceptingPlan = false; updateChrome() }
                _ = await thread.acceptPlan(handoff: false)
            }
        case .acceptAndHandoff:
            guard !isAcceptingPlan else { return }
            isAcceptingPlan = true
            localError = nil
            Task {
                defer { isAcceptingPlan = false; updateChrome() }
                guard let accepted = await thread.acceptPlan(handoff: true) else { return }
                let next = ThreadViewController(desktopId: thread.desktopId, threadId: accepted.threadId)
                navigationController?.pushViewController(next, animated: true)
            }
        case .open:
            guard !isOpeningPlan, presentedViewController == nil else { return }
            isOpeningPlan = true
            localError = nil
            Task {
                defer { isOpeningPlan = false }
                guard let content = await thread.readPlan(messageId: messageId) else {
                    localError = thread.lastError ?? String(localized: "Plan unavailable. Connect to your Mac and try opening it again.")
                    updateChrome()
                    return
                }
                guard presentedViewController == nil, view.window != nil else { return }
                let reader = TextSheetViewController(title: String(localized: "Execution plan"), text: content)
                present(UINavigationController(rootViewController: reader), animated: true)
            }
        }
    }

    func messageList(_: MessageListView, showSiblingOf messageId: String, offset: Int) {
        guard !isSwitchingBranch else { return }
        isSwitchingBranch = true
        localError = nil
        Task {
            defer { isSwitchingBranch = false; updateChrome() }
            await thread.showSibling(of: messageId, offset: offset)
        }
    }

    func messageList(_: MessageListView, didSelectToolCall toolCallId: String) {
        guard presentedViewController == nil else { return }
        let detail = UINavigationController(rootViewController: toolPreviewReader(toolCallId))
        YachiyoMaterialKit.configureSheet(detail, detents: [.medium(), .large()])
        present(detail, animated: true)
    }

    func messageList(_: MessageListView, openLink destination: String, messageId _: String) {
        switch RemoteMarkdownLink(destination) {
        case let .external(url):
            UIApplication.shared.open(url) { [weak self] opened in
                guard !opened else { return }
                Task { @MainActor in
                    self?.localError = String(localized: "This link could not be opened.")
                    self?.updateChrome()
                }
            }
        case let .workspaceFile(path):
            guard presentedViewController == nil else { return }
            guard store.link(for: thread.desktopId)?.state == .online else {
                localError = String(localized: "Connect to your Mac to preview this file.")
                updateChrome()
                return
            }
            let desktopId = thread.desktopId
            let threadId = thread.threadId
            let preview = RemoteFilePreviewController {
                let file: RemoteFilesGetOutput = try await RemoteStore.shared.call(
                    desktopId, "files.get", RemoteFilesGetInput(path: path, threadId: threadId)
                )
                return (file.filename, file.data)
            }
            present(UINavigationController(rootViewController: preview), animated: true)
        case .unsupported:
            localError = String(localized: "This link could not be opened.")
            updateChrome()
        }
    }

    private func toolPreviewReader(_ toolCallId: String, notice: String? = nil) -> TextSheetViewController {
        let call = thread.toolCall(toolCallId)
        let availability = store.link(for: thread.desktopId)?.state == .online
            ? String(localized: "Saved preview, not the complete tool result. Refresh to check for an updated preview.")
            : String(localized: "Saved preview, not the complete tool result. Connect to your Mac, then tap Refresh to update it.")
        let text = [notice, availability, call?.title,
                    call?.inputPreview.map { String(localized: "Input preview\n\($0)") },
                    call?.outputPreview.map { String(localized: "Output preview\n\($0)") }
                        ?? String(localized: "No output preview is available yet."),
                    call?.error.map { String(localized: "Error\n\($0)") }]
            .compactMap { $0 }.joined(separator: "\n\n")
        let reader = TextSheetViewController(title: call?.toolName ?? String(localized: "Tool details"), text: text)
        reader.navigationItem.leftBarButtonItem = UIBarButtonItem(title: String(localized: "Refresh"), primaryAction: UIAction { [weak self, weak reader] _ in
            guard let self, let navigation = reader?.navigationController else { return }
            guard store.link(for: thread.desktopId)?.state == .online else {
                store.retryConnection(desktopId: thread.desktopId)
                navigation.setViewControllers([toolPreviewReader(toolCallId, notice: String(localized: "Updated preview unavailable while disconnected. Reconnecting to your Mac; tap Refresh when connected."))], animated: false)
                return
            }
            reader?.navigationItem.leftBarButtonItem?.isEnabled = false
            Task {
                await self.thread.reload()
                guard navigation.presentingViewController != nil else { return }
                navigation.setViewControllers([self.toolPreviewReader(toolCallId, notice: self.thread.loadError)], animated: false)
            }
        })
        return reader
    }

    func messageList(_: MessageListView, menuForMessage messageId: String, role: MessageRole) -> UIMenu? {
        guard let message = thread.detail?.messages.first(where: { $0.id == messageId }) else { return nil }
        var actions: [UIMenuElement] = [UIAction(title: String(localized: "Copy"), image: .lucide("copy")) { _ in
            UIPasteboard.general.string = message.content
        }]
        let capabilities = thread.summary?.capabilities
        if !thread.isRunning, !thread.isReadOnly, store.link(for: thread.desktopId)?.state == .online {
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
