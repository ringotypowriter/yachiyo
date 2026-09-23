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

    private var desktopId: String?
    private var essentials: [RemoteEssential] = []
    private var essentialId: String?
    private var workspaces: [RemoteWorkspace] = []
    private var workspacePath: String?
    private var models: [RemoteSelectableModel] = []
    private var model: RemoteSelectableModel?
    private var runMode = "auto"
    private var privacy = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "New thread")
        view.backgroundColor = .yachiyo(.canvas)
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        layout()
        let online = store.desktops.filter { $0.state == .online }
        desktopId = online.first(where: \.isPrimary)?.id ?? online.first?.id
        configureDevices(online)
        Task { await loadOptions() }
    }

    private func layout() {
        deviceControl.accessibilityIdentifier = "newThread.device"
        deviceControl.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            let online = store.desktops.filter { $0.state == .online }
            desktopId = online[safe: deviceControl.selectedSegmentIndex]?.id
            Task { await self.loadOptions() }
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
        let stack = UIStackView(arrangedSubviews: [deviceControl, essentialsScroll, workspaceButton, controls, errorLabel])
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

    private func configureDevices(_ online: [DesktopSnapshot]) {
        deviceControl.removeAllSegments()
        for (index, desktop) in online.enumerated() {
            deviceControl.insertSegment(withTitle: desktop.name, at: index, animated: false)
        }
        deviceControl.selectedSegmentIndex = online.firstIndex { $0.id == desktopId } ?? 0
        deviceControl.isHidden = online.count < 2
        if online.isEmpty { errorLabel.text = String(localized: "No Mac is online right now.") }
    }

    private func loadOptions() async {
        guard let desktopId else { return }
        async let essentials: RemoteEssentialsListOutput? = try? store.call(desktopId, "essentials.list", EmptyInput())
        async let workspaces: RemoteWorkspacesListRecentOutput? = try? store.call(desktopId, "workspaces.listRecent", EmptyInput())
        async let models: RemoteModelsListSelectableOutput? = try? store.call(desktopId, "models.listSelectable", EmptyInput())
        self.essentials = await essentials?.essentials ?? []
        self.workspaces = await workspaces?.workspaces ?? []
        self.models = await models?.models ?? []
        model = self.models.first(where: \.isDefault)
        rebuildEssentials()
        updateButtons()
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
        configuration.background.cornerRadius = 14
        let selected = essentialId == id
        configuration.background.backgroundColor = selected ? .yachiyo(.accent, alpha: 0.10) : YachiyoStyle.ink(0.04)
        configuration.background.strokeColor = selected ? .yachiyo(.accent) : .clear
        configuration.background.strokeWidth = selected ? 1 : 0
        let button = UIButton(configuration: configuration)
        button.accessibilityLabel = label.isEmpty ? title : label
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
        guard let desktopId else {
            completion(false)
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            do {
                let ids = try await AttachmentUploader.upload(object.attachments, to: desktopId)
                let output: RemoteChatStartThreadOutput = try await store.call(desktopId, "chat.startThread", StartThreadInput(
                    essentialId: essentialId,
                    workspacePath: workspacePath,
                    modelOverride: model.map { ModelOverrideInput(providerName: $0.providerName, model: $0.model) },
                    runMode: runMode,
                    privacyMode: privacy ? true : nil,
                    content: object.text,
                    attachmentIds: ids.isEmpty ? nil : ids
                ))
                store.upsert(desktopId: desktopId, summary: output.thread)
                completion(true)
                onStarted?(desktopId, output.thread)
            } catch {
                errorLabel.text = (error as? RemoteCallError)?.message ?? error.localizedDescription
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
