import Combine
import UIKit
import YachiyoChatUI
import YachiyoMaterial
import YachiyoRemoteKit

/// New thread sheet: device, Essentials, workspace, model and mode, privacy, then the composer.
/// Nothing is created until the first send (`chat.startThread`), so cancelling leaves no thread.
final class NewThreadViewController: UIViewController {
    var onStarted: ((String, RemoteThreadSummary) -> Void)?

    private let store = RemoteStore.shared
    private let deviceControl = UISegmentedControl()
    private let essentialsRow = UIStackView()
    private let workspaceButton = UIButton(type: .system)
    private let modelButton = UIButton(type: .system)
    private let modeButton = UIButton(type: .system)
    private let privacyButton = UIButton(type: .system)
    private let errorLabel = UILabel()
    private let composer = ChatInputView()

    private let targetDesktopId: String?
    private var desktopId: String?
    private var essentials: [RemoteEssential] = []
    private var essentialImages: [String: UIImage] = [:]
    private var essentialId: String?
    private var workspaces: [RemoteWorkspace] = []
    private var workspacePath: String?
    private var models: [RemoteSelectableModel] = []
    private var model: RemoteSelectableModel?
    private var runMode = "auto"
    private var privacy = false
    private var cancellables: Set<AnyCancellable> = []
    private var deviceIds: [String] = []
    private var optionsDesktopId: String?
    private var optionsToken = UUID()
    private var optionsLoadTask: Task<Void, Never>?
    private var iconLoadTask: Task<Void, Never>?
    private var isLoadingOptions = false
    private var isStarting = false
    private let retryButton = UIButton(type: .system)

    init(desktopId: String? = nil) {
        targetDesktopId = desktopId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func availableDesktops(_ desktops: [DesktopSnapshot]) -> [DesktopSnapshot] {
        desktops.filter { $0.state == .online && (targetDesktopId == nil || $0.id == targetDesktopId) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "New thread")
        view.backgroundColor = .yachiyo(.canvas)
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
            guard self?.isStarting == false else { return }
            self?.dismiss(animated: true)
        })
        layout()
        let online = availableDesktops(store.desktops)
        desktopId = targetDesktopId ?? online.first(where: \.isPrimary)?.id ?? online.first?.id
        configureDevices(online)
        store.$desktops
            .receive(on: RunLoop.main)
            .sink { [weak self] desktops in self?.synchronizeDevices(desktops) }
            .store(in: &cancellables)
        startOptionsLoad()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true {
            optionsLoadTask?.cancel()
            iconLoadTask?.cancel()
        }
    }

    private func startOptionsLoad() {
        optionsLoadTask?.cancel()
        iconLoadTask?.cancel()
        optionsLoadTask = Task { await loadOptions() }
    }

    private func layout() {
        deviceControl.accessibilityIdentifier = "newThread.device"
        deviceControl.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            desktopId = deviceIds[safe: deviceControl.selectedSegmentIndex]
            startOptionsLoad()
        }, for: .valueChanged)
        essentialsRow.axis = .horizontal
        essentialsRow.spacing = 10
        let essentialsScroll = UIScrollView()
        essentialsScroll.showsHorizontalScrollIndicator = false
        essentialsRow.translatesAutoresizingMaskIntoConstraints = false
        essentialsScroll.addSubview(essentialsRow)
        NSLayoutConstraint.activate([
            essentialsRow.leadingAnchor.constraint(equalTo: essentialsScroll.contentLayoutGuide.leadingAnchor),
            essentialsRow.trailingAnchor.constraint(equalTo: essentialsScroll.contentLayoutGuide.trailingAnchor),
            essentialsRow.topAnchor.constraint(equalTo: essentialsScroll.contentLayoutGuide.topAnchor),
            essentialsRow.bottomAnchor.constraint(equalTo: essentialsScroll.contentLayoutGuide.bottomAnchor),
            essentialsRow.heightAnchor.constraint(equalTo: essentialsScroll.frameLayoutGuide.heightAnchor),
            essentialsScroll.heightAnchor.constraint(equalToConstant: 56),
        ])
        for (button, identifier) in [(workspaceButton, "newThread.workspace"), (modelButton, "newThread.model"), (modeButton, "newThread.mode"), (privacyButton, "newThread.privacy")] {
            button.accessibilityIdentifier = identifier
            button.showsMenuAsPrimaryAction = button !== privacyButton
            button.contentHorizontalAlignment = .leading
        }
        privacyButton.addAction(UIAction { [weak self] _ in
            self?.privacy.toggle()
            self?.updateButtons()
        }, for: .touchUpInside)
        let controls = UIStackView(arrangedSubviews: [modeButton, modelButton, privacyButton])
        controls.spacing = 8
        controls.distribution = .fill
        for button in [modeButton, privacyButton] {
            button.setContentHuggingPriority(.required, for: .horizontal)
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        modelButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        errorLabel.font = YachiyoFonts.caption()
        errorLabel.textColor = .yachiyo(.dangerStrong)
        errorLabel.numberOfLines = 0
        errorLabel.accessibilityIdentifier = "newThread.error"
        retryButton.setTitle(String(localized: "Retry loading options"), for: .normal)
        retryButton.isHidden = true
        retryButton.addAction(UIAction { [weak self] _ in
            self?.startOptionsLoad()
        }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [deviceControl, essentialsScroll, workspaceButton, controls, errorLabel, retryButton])
        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        // Options must scroll rather than compress the manually laid-out composer when the
        // keyboard or an iPad multitasking window leaves little vertical space.
        let optionsScroll = UIScrollView()
        optionsScroll.translatesAutoresizingMaskIntoConstraints = false
        optionsScroll.contentInsetAdjustmentBehavior = .never
        optionsScroll.keyboardDismissMode = .interactive
        optionsScroll.addSubview(stack)
        view.addSubview(optionsScroll)

        composer.delegate = self
        composer.placeholder = String(localized: "Message Yachiyo…")
        composer.bind(conversationID: "new-thread")
        composer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(composer)
        NSLayoutConstraint.activate([
            optionsScroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            optionsScroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            optionsScroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            optionsScroll.bottomAnchor.constraint(equalTo: composer.topAnchor),
            stack.topAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.bottomAnchor, constant: -12),
            stack.widthAnchor.constraint(equalTo: optionsScroll.frameLayoutGuide.widthAnchor, constant: -40),
            composer.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 2),
            composer.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -2),
            composer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            composer.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor),
        ])
        updateButtons()
    }

    private func synchronizeDevices(_ desktops: [DesktopSnapshot]) {
        guard !isStarting else { return }
        let online = availableDesktops(desktops)
        guard online.map(\.id) != deviceIds else { return }
        let previous = desktopId
        if !online.contains(where: { $0.id == desktopId }) {
            desktopId = targetDesktopId ?? online.first(where: \.isPrimary)?.id ?? online.first?.id
        }
        configureDevices(online)
        if previous != desktopId || targetDesktopId != nil {
            optionsToken = UUID()
            isLoadingOptions = false
            optionsLoadTask?.cancel()
            iconLoadTask?.cancel()
            if online.contains(where: { $0.id == desktopId }) { startOptionsLoad() }
            updateInteraction()
        }
    }

    private func configureDevices(_ online: [DesktopSnapshot]) {
        deviceIds = online.map(\.id)
        deviceControl.removeAllSegments()
        for (index, desktop) in online.enumerated() {
            deviceControl.insertSegment(withTitle: desktop.name, at: index, animated: false)
        }
        deviceControl.selectedSegmentIndex = online.firstIndex { $0.id == desktopId } ?? 0
        deviceControl.isHidden = targetDesktopId != nil || online.count < 2
        if online.isEmpty {
            optionsLoadTask?.cancel()
            iconLoadTask?.cancel()
            optionsDesktopId = nil
            optionsToken = UUID()
            isLoadingOptions = false
            essentialId = nil
            workspacePath = nil
            model = nil
            essentials = []
            workspaces = []
            models = []
            retryButton.isHidden = true
            errorLabel.textColor = .yachiyo(.dangerStrong)
            errorLabel.text = targetDesktopId == nil
                ? String(localized: "No Mac is online right now.")
                : String(localized: "Your Mac is offline. Reconnect before sending. Your draft is kept.")
            rebuildEssentials()
        }
        updateButtons()
    }

    private func loadOptions() async {
        guard !Task.isCancelled else { return }
        guard let desktopId, !isStarting, store.desktops.contains(where: { $0.id == desktopId && $0.state == .online }) else { return }
        let token = UUID()
        optionsToken = token
        isLoadingOptions = true
        if optionsDesktopId != desktopId {
            essentialImages = [:]
            optionsDesktopId = desktopId
            essentialId = nil
            workspacePath = nil
            model = nil
            essentials = []
            workspaces = []
            models = []
        }
        errorLabel.textColor = .secondaryLabel
        errorLabel.text = String(localized: "Loading options…")
        retryButton.isHidden = true
        rebuildEssentials()
        updateButtons()
        async let essentials: RemoteEssentialsListOutput? = try? store.call(desktopId, "essentials.list", EmptyInput())
        async let workspaces: RemoteWorkspacesListRecentOutput? = try? store.call(desktopId, "workspaces.listRecent", EmptyInput())
        async let models: RemoteModelsListSelectableOutput? = try? store.call(desktopId, "models.listSelectable", EmptyInput())
        let results = await (essentials, workspaces, models)
        guard optionsToken == token, self.desktopId == desktopId, !Task.isCancelled else { return }
        isLoadingOptions = false
        if let result = results.0 {
            let previous = Dictionary(uniqueKeysWithValues: self.essentials.map { ($0.id, $0) })
            essentialImages = essentialImages.filter { id, _ in
                result.essentials.contains { $0.id == id && $0.hasImageIcon == true
                    && $0.iconVersion == previous[id]?.iconVersion }
            }
            self.essentials = result.essentials
            if let essentialId, !self.essentials.contains(where: { $0.id == essentialId }) {
                self.essentialId = nil
            }
        }
        if let result = results.1 { self.workspaces = result.workspaces }
        if let result = results.2 {
            self.models = result.models
            if model == nil || !self.models.contains(where: { $0 == model }) {
                model = self.models.first(where: \.isDefault)
            }
        }
        let failed = results.0 == nil || results.1 == nil || results.2 == nil
        errorLabel.textColor = .yachiyo(.dangerStrong)
        errorLabel.text = failed ? String(localized: "Some options couldn't be loaded. Retry, or start with the available defaults.") : nil
        retryButton.isHidden = !failed
        rebuildEssentials()
        updateButtons()
        iconLoadTask = Task { await loadEssentialImages(desktopId: desktopId, token: token) }
    }

    private func loadEssentialImages(desktopId: String, token: UUID) async {
        for essential in essentials where essential.hasImageIcon == true {
            guard optionsToken == token, self.desktopId == desktopId, !Task.isCancelled else { return }
            let data = await RemoteEssentialIconCache.shared.imageData(
                desktopId: desktopId, essentialId: essential.id, iconVersion: essential.iconVersion
            ) { [store] in
                try? await store.call(
                    desktopId, "essentials.getIcon", RemoteEssentialsGetIconInput(essentialId: essential.id)
                )
            }
            guard optionsToken == token, self.desktopId == desktopId, !Task.isCancelled else { return }
            guard let data,
                  let image = UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 32, height: 32)) else { continue }
            essentialImages[essential.id] = image.withRenderingMode(.alwaysOriginal)
            rebuildEssentials()
        }
    }

    private func updateInteraction() {
        let enabled = store.desktops.contains { $0.id == desktopId && $0.state == .online } && !isStarting
        deviceControl.isEnabled = !isStarting
        workspaceButton.isEnabled = enabled
        modelButton.isEnabled = enabled && !models.isEmpty
        modeButton.isEnabled = enabled
        privacyButton.isEnabled = enabled
        essentialsRow.isUserInteractionEnabled = enabled
        retryButton.isEnabled = enabled && !isLoadingOptions
        navigationItem.leftBarButtonItem?.isEnabled = !isStarting
        isModalInPresentation = isStarting
        navigationController?.isModalInPresentation = isStarting
    }

    private func rebuildEssentials() {
        essentialsRow.arrangedSubviews.forEach { $0.removeFromSuperview() }
        essentialsRow.addArrangedSubview(makeEssentialTile(title: "＋", id: nil, label: String(localized: "Blank")))
        for essential in essentials {
            essentialsRow.addArrangedSubview(makeEssentialTile(title: essential.icon ?? "•", id: essential.id, label: essential.label ?? ""))
        }
    }

    private func makeEssentialTile(title: String, id: String?, label: String) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        if let id, let image = essentialImages[id] {
            configuration.title = nil
            configuration.image = image
        }
        configuration.background.cornerRadius = 14
        let selected = essentialId == id
        configuration.background.backgroundColor = selected ? .yachiyo(.accent, alpha: 0.10) : YachiyoStyle.ink(0.04)
        configuration.background.strokeColor = selected ? .yachiyo(.accent) : .clear
        configuration.background.strokeWidth = selected ? 1 : 0
        let button = UIButton(configuration: configuration)
        button.accessibilityLabel = label.isEmpty ? title : label
        button.isSelected = selected
        button.accessibilityIdentifier = "newThread.essential.\(id ?? "blank")"
        button.widthAnchor.constraint(equalToConstant: 56).isActive = true
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            essentialId = id
            let essential = essentials.first { $0.id == id }
            workspacePath = essential?.workspacePath
            privacy = essential?.privacyMode ?? false
            rebuildEssentials()
            updateButtons()
        }, for: .touchUpInside)
        return button
    }

    private func updateButtons() {
        updateInteraction()
        var workspace = UIButton.Configuration.plain()
        workspace.image = .lucide("folder")
        workspace.imagePadding = 8
        workspace.title = workspacePath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? String(localized: "Temporary workspace")
        workspace.baseForegroundColor = workspacePath == nil ? .secondaryLabel : .yachiyo(.accentStrong)
        workspaceButton.configuration = workspace
        workspaceButton.menu = UIMenu(children: [UIAction(title: String(localized: "Temporary workspace")) { [weak self] _ in
            self?.workspacePath = nil
            self?.updateButtons()
        }] + workspaces.map { entry in
            UIAction(title: entry.name, subtitle: entry.path, state: entry.path == workspacePath ? .on : .off) { [weak self] _ in
                self?.workspacePath = entry.path
                self?.updateButtons()
            }
        })

        var modelConfiguration = UIButton.Configuration.gray()
        modelConfiguration.image = .lucide("cpu")
        modelConfiguration.imagePadding = 4
        modelConfiguration.title = model?.model ?? String(localized: "Default model")
        modelConfiguration.cornerStyle = .capsule
        modelConfiguration.titleLineBreakMode = .byTruncatingMiddle
        modelButton.configuration = modelConfiguration
        let grouped = Dictionary(grouping: models, by: \.providerName)
        modelButton.menu = UIMenu(children: grouped.keys.sorted().map { provider in
            UIMenu(title: provider, options: .displayInline, children: (grouped[provider] ?? []).map { option in
                UIAction(title: option.model, state: option == model ? .on : .off) { [weak self] _ in
                    self?.model = option
                    self?.updateButtons()
                }
            })
        })

        var mode = UIButton.Configuration.gray()
        mode.image = .lucide(["auto": "zap", "explore": "telescope", "plan": "map", "chat": "message-square"][runMode] ?? "zap")
        mode.imagePadding = 4
        mode.title = runMode.capitalized
        mode.cornerStyle = .capsule
        modeButton.configuration = mode
        modeButton.menu = UIMenu(children: ["auto", "explore", "plan", "chat"].map { option in
            UIAction(title: option.capitalized, state: option == runMode ? .on : .off) { [weak self] _ in
                self?.runMode = option
                self?.updateButtons()
            }
        })

        var privacyConfiguration = UIButton.Configuration.gray()
        privacyConfiguration.image = UIImage(systemName: privacy ? "eye.slash" : "eye")
        privacyConfiguration.cornerStyle = .capsule
        privacyConfiguration.baseForegroundColor = privacy ? .yachiyo(.accentStrong) : .secondaryLabel
        privacyButton.configuration = privacyConfiguration
        privacyButton.accessibilityLabel = privacy ? String(localized: "Privacy mode on") : String(localized: "Privacy mode off")
    }
}

extension NewThreadViewController: ChatInputDelegate {
    func chatInputDidSubmit(_: ChatInputView, object: ChatInputContent, completion: @escaping @Sendable (Bool) -> Void) {
        guard !isStarting else { completion(false); return }
        errorLabel.textColor = .yachiyo(.dangerStrong)
        guard let desktopId, store.desktops.contains(where: { $0.id == desktopId && $0.state == .online }) else {
            errorLabel.text = String(localized: "Your Mac is offline. Reconnect before sending. Your draft is kept.")
            completion(false)
            return
        }
        isStarting = true
        let selectedEssential = essentialId
        let selectedWorkspace = workspacePath
        let selectedModel = model
        let selectedMode = runMode
        let selectedPrivacy = privacy
        errorLabel.text = nil
        updateInteraction()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            var started = false
            defer {
                isStarting = false
                if !started { synchronizeDevices(store.desktops) }
                updateInteraction()
            }
            var requestedCreation = false
            do {
                let ids = try await AttachmentUploader.upload(object.attachments, to: desktopId)
                requestedCreation = true
                let output: RemoteChatStartThreadOutput = try await store.call(desktopId, "chat.startThread", StartThreadInput(
                    essentialId: selectedEssential,
                    workspacePath: selectedWorkspace,
                    modelOverride: selectedModel.map { ModelOverrideInput(providerName: $0.providerName, model: $0.model) },
                    runMode: selectedMode,
                    privacyMode: selectedPrivacy ? true : nil,
                    content: object.text,
                    attachmentIds: ids.isEmpty ? nil : ids
                ))
                if let userMessage = output.accepted.userMessage {
                    let images = object.attachments.filter { $0.type == .image }
                    if images.count == userMessage.images.count {
                        let sentImages = RemoteSentImageStore(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteSentImages", isDirectory: true))
                        for (image, reference) in zip(images, userMessage.images) {
                            // The thread was created successfully even if its local preview cannot be retained.
                            try? sentImages.save(image.fileData, desktopId: desktopId, threadId: output.thread.id, messageId: userMessage.id, imageId: reference.imageId)
                        }
                    }
                }
                store.upsert(desktopId: desktopId, summary: output.thread)
                // Keep the accepted first message available even if the first threads.load fails.
                store.cacheThread(desktopId: desktopId, detail: RemoteThreadDetail(
                    activeRunId: output.accepted.runId,
                    activeRunMode: nil,
                    hasMoreBefore: false,
                    messages: output.accepted.userMessage.map { [$0] } ?? [],
                    pendingPlan: false,
                    queuedFollowUps: [],
                    streamSnapshotSeq: nil,
                    thread: output.thread,
                    todoItems: [],
                    toolCalls: []
                ), needsRefresh: true)
                started = true
                completion(true)
                onStarted?(desktopId, output.thread)
            } catch {
                let detail = (error as? RemoteCallError)?.message ?? error.localizedDescription
                errorLabel.text = requestedCreation && !(error is RemoteCallError)
                    ? String(localized: "Creation unconfirmed. Check your inbox before trying again to avoid a duplicate thread. Your draft is kept.") + " " + detail
                    : detail
                // Device resynchronization may replace the inline message with option progress.
                if availableDesktops(store.desktops).map(\.id) != deviceIds {
                    let alert = UIAlertController(title: String(localized: "Couldn't start thread"), message: errorLabel.text, preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default))
                    present(alert, animated: true)
                }
                completion(false)
            }
        }
    }
}

struct ModelOverrideInput: Encodable { let providerName: String; let model: String }
struct StartThreadInput: Encodable {
    let essentialId: String?
    let workspacePath: String?
    let modelOverride: ModelOverrideInput?
    let runMode: String
    let privacyMode: Bool?
    let content: String
    let attachmentIds: [String]?
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
