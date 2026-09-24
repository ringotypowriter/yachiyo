import Combine
import UIKit
import UniformTypeIdentifiers
import YachiyoMaterial
import YachiyoRemoteKit

/// Settings: devices, appearance, address recovery, about. Two levels only: section → item.
final class SettingsViewController: UITableViewController {
    private enum Section: Int, CaseIterable { case devices, appearance, recovery, about }

    private let store = RemoteStore.shared
    private var desktops: [DesktopSnapshot] = []
    private var recoveryFolderDidChange: (() -> Void)?
    private var cancellables: Set<AnyCancellable> = []

    init() {
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "Settings")
        tableView.backgroundColor = .yachiyo(.canvas)
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        desktops = store.desktops
        store.$desktops
            .receive(on: DispatchQueue.main)
            .sink { [weak self] snapshots in
                self?.desktops = snapshots
                self?.tableView.reloadData()
            }
            .store(in: &cancellables)
    }

    override func numberOfSections(in _: UITableView) -> Int { Section.allCases.count }

    override func tableView(_: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .devices: String(localized: "Devices")
        case .appearance: String(localized: "Appearance")
        case .recovery: String(localized: "Address recovery")
        case .about: String(localized: "About")
        }
    }

    override func tableView(_: UITableView, titleForFooterInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .devices:
            String(localized: "Removing a device here only affects this iPhone. To revoke it, use Settings > Remote on the Mac.")
        case .recovery:
            String(localized: "Optional. Find your Mac again if its address changes. Choose iCloud Drive > Documents > Yachiyo. Pairing and chat do not require this folder.")
        default:
            nil
        }
    }

    override func tableView(_: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch Section(rawValue: section)! {
        case .devices: desktops.count + 1
        case .appearance: desktops.count > 1 ? 3 : 2
        case .recovery: 1
        case .about: 3
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .value1, reuseIdentifier: nil)
        var content = UIListContentConfiguration.valueCell()
        cell.accessoryView = nil
        cell.accessoryType = .none
        switch Section(rawValue: indexPath.section)! {
        case .devices:
            if let desktop = desktops[safe: indexPath.row] {
                content = UIListContentConfiguration.subtitleCell()
                content.text = desktop.name
                content.image = UIImage(systemName: "circle.fill")
                content.imageProperties.tintColor = desktop.state == .online ? .yachiyo(.success) : .yachiyo(.danger)
                content.imageProperties.maximumSize = CGSize(width: 8, height: 8)
                let address = desktop.activeURL ?? desktop.attemptingURL ?? desktop.endpoints.first?.url ?? desktop.lastSuccessfulURL
                content.secondaryText = [stateText(desktop.state), address].compactMap { $0 }.joined(separator: " · ")
                content.secondaryTextProperties.numberOfLines = 2
                content.secondaryTextProperties.lineBreakMode = .byTruncatingMiddle
                cell.accessoryType = .disclosureIndicator
                cell.accessibilityIdentifier = "settings.device.\(desktop.id)"
            } else {
                content.text = String(localized: "Add device")
                content.textProperties.color = .yachiyo(.accentStrong)
                cell.accessibilityIdentifier = "settings.addDevice"
            }
        case .appearance:
            switch indexPath.row {
            case 0:
                content.text = String(localized: "Theme")
                content.secondaryText = ThemeController.shared.themeOverride?.displayName ?? String(localized: "Follow \(primaryName)")
                cell.accessoryView = menuButton(themeMenu())
            case 1:
                content.text = String(localized: "Light or dark")
                content.secondaryText = String(localized: "System")
            default:
                content.text = String(localized: "Primary device")
                content.secondaryText = primaryName
                cell.accessoryView = menuButton(primaryMenu())
            }
        case .recovery:
            content.text = String(localized: "Yachiyo recovery folder")
            content.secondaryText = MailboxFolder.isGranted ? String(localized: "Configured") : String(localized: "Not configured")
            cell.accessibilityIdentifier = "settings.addressRecovery"
            cell.accessoryType = .disclosureIndicator
        case .about:
            switch indexPath.row {
            case 0:
                content.text = String(localized: "Version")
                content.secondaryText = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
            case 1:
                content.text = String(localized: "Protocol")
                content.secondaryText = String(remoteProtocolVersion)
            default:
                content.text = String(localized: "Open source licenses")
                cell.accessoryType = .disclosureIndicator
            }
        }
        content.textProperties.numberOfLines = 0
        if Section(rawValue: indexPath.section) == .appearance {
            content.secondaryTextProperties.numberOfLines = 0
            cell.selectionStyle = .none
            cell.accessoryView?.accessibilityLabel = content.text
            cell.accessoryView?.accessibilityValue = content.secondaryText
        } else if Section(rawValue: indexPath.section) == .about, indexPath.row < 2 {
            cell.selectionStyle = .none
        } else {
            cell.accessibilityTraits.insert(.button)
        }
        cell.contentConfiguration = content
        cell.backgroundColor = .yachiyo(.surface)
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        switch Section(rawValue: indexPath.section)! {
        case .devices where indexPath.row == desktops.count:
            let pairing = PairingViewController(initialURL: nil)
            pairing.onFinished = { [weak self] in self?.dismiss(animated: true) }
            let container = UINavigationController(rootViewController: pairing)
            container.modalPresentationStyle = .fullScreen
            present(container, animated: true)
        case .devices:
            guard let desktop = desktops[safe: indexPath.row] else { return }
            let device = DeviceViewController(desktop: desktop)
            device.onChooseRecoveryFolder = { [weak self] presenter, completion in
                self?.explainRecoveryFolder(from: presenter, onChange: completion)
            }
            navigationController?.pushViewController(device, animated: true)
        case .recovery:
            explainRecoveryFolder(from: self)
        case .about where indexPath.row == 2:
            let notices = Bundle.main.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "md")
                .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
            navigationController?.pushViewController(TextSheetViewController(title: String(localized: "Licenses"), text: notices), animated: true)
        default:
            break
        }
    }

    override func tableView(_: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard Section(rawValue: indexPath.section) == .devices, let desktop = desktops[safe: indexPath.row] else { return nil }
        let remove = UIContextualAction(style: .destructive, title: String(localized: "Remove")) { [weak self] _, _, done in
            done(false)
            guard let self else { return }
            let alert = UIAlertController(
                title: String(localized: "Forget \(desktop.name)?"),
                message: String(localized: "You’ll need to pair again to use this device on this iPhone. This does not revoke access on the Mac."),
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
            alert.addAction(UIAlertAction(title: String(localized: "Forget device"), style: .destructive) { [weak self] _ in
                self?.store.remove(desktopId: desktop.id)
            })
            present(alert, animated: true)
        }
        let configuration = UISwipeActionsConfiguration(actions: [remove])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    // MARK: Helpers

    private func explainRecoveryFolder(from presenter: UIViewController, onChange: (() -> Void)? = nil) {
        recoveryFolderDidChange = onChange
        let alert = UIAlertController(
            title: String(localized: "Set up address recovery"),
            message: String(localized: "In the folder picker, open Browse > iCloud Drive > Documents, open Yachiyo, then tap Open. Select Yachiyo itself, not Remote or Sync.\n\nYour Mac creates this folder after pairing. Use the same Apple Account with iCloud Drive on both devices. If it is missing, let iCloud finish syncing and try later; do not create a new folder. You can keep using your paired Mac without this step."),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: String(localized: "Not now"), style: .cancel) { [weak self] _ in
            self?.recoveryFolderDidChange = nil
        })
        alert.addAction(UIAlertAction(title: String(localized: "Choose Yachiyo folder"), style: .default) { [weak self, weak presenter] _ in
            guard let self, let presenter else { return }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            presenter.present(picker, animated: true)
        })
        presenter.present(alert, animated: true)
    }

    private var primaryName: String {
        desktops.first(where: \.isPrimary)?.name ?? String(localized: "your Mac")
    }

    private func stateText(_ state: DesktopConnectionState) -> String {
        switch state {
        case .online: String(localized: "Online")
        case .connecting: String(localized: "Connecting…")
        case let .offline(lastSeen):
            lastSeen.map { String(localized: "Last seen \($0.formatted(.relative(presentation: .named)))") } ?? String(localized: "Offline")
        case .protocolMismatch: String(localized: "Needs update")
        }
    }

    private func menuButton(_ menu: UIMenu) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "chevron.up.chevron.down"), for: .normal)
        button.menu = menu
        button.showsMenuAsPrimaryAction = true
        button.frame.size = CGSize(width: 44, height: 44)
        return button
    }

    private func themeMenu() -> UIMenu {
        let follow = UIAction(title: String(localized: "Follow \(primaryName)"), state: ThemeController.shared.themeOverride == nil ? .on : .off) { [weak self] _ in
            ThemeController.shared.themeOverride = nil
            self?.tableView.reloadData()
        }
        let themes = YachiyoThemeID.allCases.map { theme in
            UIAction(title: theme.displayName, state: ThemeController.shared.themeOverride == theme ? .on : .off) { [weak self] _ in
                ThemeController.shared.themeOverride = theme
                self?.tableView.reloadData()
            }
        }
        return UIMenu(children: [follow, UIMenu(options: .displayInline, children: themes)])
    }

    private func primaryMenu() -> UIMenu {
        UIMenu(children: desktops.map { desktop in
            UIAction(title: desktop.name, state: desktop.isPrimary ? .on : .off) { [weak self] _ in
                self?.store.setPrimaryDesktop(desktop.id)
            }
        })
    }
}

extension SettingsViewController: UIDocumentPickerDelegate {
    func documentPickerWasCancelled(_: UIDocumentPickerViewController) {
        recoveryFolderDidChange = nil
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        defer { recoveryFolderDidChange = nil }
        guard let folder = urls.first else { return }
        do {
            try MailboxFolder.save(folder: folder)
            recoveryFolderDidChange?()
            recoveryFolderDidChange = nil
        } catch {
            let alert = UIAlertController(
                title: String(localized: "Recovery folder not saved"),
                message: String(localized: "Choose iCloud Drive > Documents > Yachiyo, containing the Remote folder created by your Mac. Do not select Documents, Remote, or Sync. If Yachiyo or Remote is missing, check iCloud Drive on your Mac and wait for syncing, then try again. Your pairing is unchanged."),
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default))
            let presenter = controller.presentingViewController ?? navigationController?.topViewController ?? self
            controller.dismiss(animated: true) {
                presenter.present(alert, animated: true)
            }
        }
        tableView.reloadData()
    }
}
