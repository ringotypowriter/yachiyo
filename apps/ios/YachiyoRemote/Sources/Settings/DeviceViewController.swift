import Combine
import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// Connection facts and saved targets are deliberately separate: a saved URL is not proof of a connection.
final class DeviceViewController: UITableViewController {
    var onChooseRecoveryFolder: ((UIViewController, @escaping () -> Void) -> Void)?

    private enum Section: Int, CaseIterable { case connection, addresses, recovery, device }
    private struct Row {
        let title: String
        var detail: String? = nil
        var symbol: String? = nil
        var copyValue: String? = nil
        var action: Action? = nil
        var identifier: String? = nil
    }
    private enum Action { case edit, checkRecovery, chooseFolder, primary, forget }

    private let store = RemoteStore.shared
    private var desktop: DesktopSnapshot
    private var cancellables: Set<AnyCancellable> = []
    private var checkingRecovery = false

    init(desktop: DesktopSnapshot) {
        self.desktop = desktop
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = desktop.name
        tableView.backgroundColor = .yachiyo(.canvas)
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 72
        store.$desktops
            .receive(on: DispatchQueue.main)
            .sink { [weak self] snapshots in
                guard let self else { return }
                guard let updated = snapshots.first(where: { $0.id == self.desktop.id }) else {
                    if self.navigationController?.topViewController === self {
                        self.navigationController?.popViewController(animated: true)
                    }
                    return
                }
                self.desktop = updated
                self.title = updated.name
                self.tableView.reloadData()
            }
            .store(in: &cancellables)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        tableView.reloadData()
    }

    override func numberOfSections(in _: UITableView) -> Int { Section.allCases.count }

    override func tableView(_: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows(in: Section(rawValue: section)!).count
    }

    override func tableView(_: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .connection: String(localized: "Connection")
        case .addresses: String(localized: "Saved server addresses")
        case .recovery: String(localized: "iCloud address recovery")
        case .device: String(localized: "Device")
        }
    }

    override func tableView(_: UITableView, titleForFooterInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .connection: nil
        case .addresses: String(localized: "Editing keeps your pairing.")
        case .recovery: MailboxFolder.isGranted ? nil : String(localized: "Choose iCloud Drive > Documents > Yachiyo, created by your Mac.")
        case .device: String(localized: "Forgetting this device only removes it from this iPhone. To revoke access, use Settings > Remote on the Mac.")
        }
    }

    private func rows(in section: Section) -> [Row] {
        switch section {
        case .connection:
            var rows = [Row(title: String(localized: "Status"), detail: stateText)]
            if let url = desktop.activeURL {
                rows.append(Row(title: String(localized: "Connected address"), detail: url, copyValue: url, identifier: "device.connectedURL"))
            }
            if let url = desktop.attemptingURL {
                rows.append(Row(title: String(localized: "Trying address"), detail: url, copyValue: url, identifier: "device.attemptingURL"))
            }
            if let url = desktop.lastSuccessfulURL, url != desktop.activeURL {
                rows.append(Row(title: String(localized: "Last connected address"), detail: url, copyValue: url, identifier: "device.lastConnectedURL"))
            }
            if desktop.activeURL == nil && desktop.attemptingURL == nil && desktop.lastSuccessfulURL == nil {
                rows.append(Row(title: String(localized: "Connected address"), detail: String(localized: "No connection recorded")))
            }
            if let error = desktop.lastConnectionError {
                rows.append(Row(title: String(localized: "Last connection failure"), detail: error))
            }
            return rows
        case .addresses:
            var rows = desktop.endpoints.enumerated().map { index, endpoint in
                Row(title: index == 0 ? String(localized: "Saved target") : String(localized: "Alternate saved target"), detail: endpoint.url, copyValue: endpoint.url, identifier: "device.savedURL.\(index)")
            }
            if rows.isEmpty { rows.append(Row(title: String(localized: "Saved target"), detail: String(localized: "No saved address"))) }
            if let updatedAt = desktop.lastAddressUpdateAt {
                let source = desktop.endpoints.first?.kind == "manual" ? String(localized: "Manual") : String(localized: "iCloud")
                rows.append(Row(title: String(localized: "Last address change"), detail: "\(source) · \(updatedAt.formatted(date: .abbreviated, time: .standard))"))
            }
            rows.append(Row(title: String(localized: "Edit server address"), symbol: "pencil", action: .edit, identifier: "device.editAddress"))
            return rows
        case .recovery:
            var rows = [
                Row(title: String(localized: "Recovery folder"), detail: MailboxFolder.isGranted ? String(localized: "Configured") : String(localized: "Not configured")),
                Row(title: String(localized: "Last check"), detail: recoveryText, identifier: "device.recovery.status"),
            ]
            rows.append(Row(title: checkingRecovery ? String(localized: "Checking for a new address…") : String(localized: "Check for new address"), symbol: "arrow.clockwise", action: .checkRecovery, identifier: "device.recovery.check"))
            rows.append(Row(title: String(localized: "Choose recovery folder"), symbol: "folder", action: .chooseFolder, identifier: "device.recovery.folder"))
            return rows
        case .device:
            return [
                Row(title: desktop.isPrimary ? String(localized: "Primary device") : String(localized: "Make primary device"), symbol: desktop.isPrimary ? "checkmark.circle" : "star", action: desktop.isPrimary ? nil : .primary),
                Row(title: String(localized: "Forget device"), symbol: "trash", action: .forget),
            ]
        }
    }

    private var stateText: String {
        switch desktop.state {
        case .online: String(localized: "Online")
        case .connecting: String(localized: "Connecting…")
        case let .offline(lastSeen):
            lastSeen.map { String(localized: "Offline · Last seen \($0.formatted(date: .abbreviated, time: .shortened))") } ?? String(localized: "Offline")
        case .protocolMismatch: String(localized: "Needs update")
        }
    }

    private var recoveryText: String {
        guard let recovery = desktop.recovery else { return String(localized: "Not checked yet") }
        let outcome: String
        switch recovery.outcome {
        case .checking: outcome = String(localized: "Checking…")
        case .notConfigured: outcome = String(localized: "Recovery folder not configured")
        case .notFound: outcome = String(localized: "No recovery record found")
        case .unchanged: outcome = String(localized: "Record read · Address unchanged")
        case .updated: outcome = String(localized: "Record read · Address updated")
        case .failed: outcome = String(localized: "Couldn’t read recovery address")
        }
        let checkedAt = recovery.checkedAt?.formatted(date: .abbreviated, time: .standard)
        return [outcome, checkedAt, recovery.detail].compactMap { $0 }.joined(separator: "\n")
    }

    override func tableView(_: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = rows(in: Section(rawValue: indexPath.section)!)[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        var content = UIListContentConfiguration.subtitleCell()
        content.text = row.title
        content.secondaryText = row.detail
        content.textProperties.numberOfLines = 0
        content.secondaryTextProperties.numberOfLines = 0
        content.secondaryTextProperties.lineBreakMode = .byCharWrapping
        content.textProperties.color = .yachiyo(.ink)
        content.secondaryTextProperties.color = .yachiyo(.textSecondary)
        content.image = row.symbol.flatMap { UIImage(systemName: $0) }
        content.imageProperties.tintColor = .yachiyo(.accentStrong)
        if row.action != nil { content.textProperties.color = .yachiyo(.accentStrong) }
        if case .forget? = row.action {
            content.textProperties.color = .yachiyo(.danger)
            content.imageProperties.tintColor = .yachiyo(.danger)
        }
        cell.backgroundColor = .yachiyo(.surface)
        cell.selectionStyle = row.action != nil || row.copyValue != nil ? .default : .none
        if let copyValue = row.copyValue {
            let copy = UIButton(type: .system)
            copy.setImage(UIImage(systemName: "doc.on.doc"), for: .normal)
            copy.accessibilityLabel = String(localized: "Copy \(row.title)")
            copy.addAction(UIAction { [weak self] _ in self?.copyAddress(copyValue) }, for: .touchUpInside)
            copy.accessibilityIdentifier = row.identifier.map { "\($0).copy" }
            copy.frame.size = CGSize(width: 44, height: 44)
            cell.accessoryView = copy
            cell.accessibilityHint = String(localized: "Double-tap to copy the full URL")
        }
        if case .chooseFolder? = row.action { cell.accessoryType = .disclosureIndicator }
        if case .checkRecovery? = row.action, checkingRecovery || desktop.recovery?.outcome == .checking {
            cell.isUserInteractionEnabled = false
            content.textProperties.color = .yachiyo(.textSecondary)
        }
        cell.contentConfiguration = content
        cell.accessibilityIdentifier = row.identifier ?? "device.\(indexPath.section).\(indexPath.row)"
        cell.isAccessibilityElement = true
        cell.accessibilityLabel = row.title
        cell.accessibilityValue = row.detail
        cell.accessibilityTraits = row.action != nil || row.copyValue != nil ? .button : .staticText
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let row = rows(in: Section(rawValue: indexPath.section)!)[indexPath.row]
        if let url = row.copyValue { copyAddress(url); return }
        guard let action = row.action else { return }
        switch action {
        case .edit:
            let editor = ServerAddressViewController(desktopId: desktop.id, address: desktop.endpoints.first?.url ?? "")
            let navigation = UINavigationController(rootViewController: editor)
            navigation.modalPresentationStyle = .formSheet
            present(navigation, animated: true)
        case .checkRecovery:
            checkRecovery()
        case .chooseFolder:
            onChooseRecoveryFolder?(self, { [weak self] in
                self?.tableView.reloadData()
                self?.checkRecovery()
            })
        case .primary:
            store.setPrimaryDesktop(desktop.id)
        case .forget:
            confirmForget()
        }
    }

    private func copyAddress(_ url: String) {
        UIPasteboard.general.string = url
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        UIAccessibility.post(notification: .announcement, argument: String(localized: "Address copied"))
    }

    private func checkRecovery() {
        guard !checkingRecovery else { return }
        checkingRecovery = true
        tableView.reloadData()
        Task { [weak self] in
            guard let self else { return }
            await store.checkAddressRecovery(desktopId: desktop.id)
            checkingRecovery = false
            tableView.reloadData()
        }
    }

    private func confirmForget() {
        let alert = UIAlertController(title: String(localized: "Forget \(desktop.name)?"), message: String(localized: "You’ll need to pair again to use this device on this iPhone."), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "Forget device"), style: .destructive) { [weak self] _ in
            guard let self else { return }
            store.remove(desktopId: desktop.id)
            navigationController?.popViewController(animated: true)
        })
        present(alert, animated: true)
    }
}

/// A normal server URL replaces only the target; no pairing link or credential is requested.
private final class ServerAddressViewController: UITableViewController, UITextFieldDelegate {
    private let desktopId: String
    private let addressField = UITextField()
    private var errorMessage: String?

    init(desktopId: String, address: String) {
        self.desktopId = desktopId
        super.init(style: .insetGrouped)
        addressField.text = address
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "Edit server address")
        tableView.backgroundColor = .yachiyo(.canvas)
        tableView.keyboardDismissMode = .interactive
        addressField.keyboardType = .URL
        addressField.autocapitalizationType = .none
        addressField.autocorrectionType = .no
        addressField.spellCheckingType = .no
        addressField.smartQuotesType = .no
        addressField.smartDashesType = .no
        addressField.clearButtonMode = .whileEditing
        addressField.returnKeyType = .done
        addressField.placeholder = "https://your-mac.example.com"
        addressField.font = .preferredFont(forTextStyle: .body)
        addressField.adjustsFontForContentSizeCategory = true
        addressField.textColor = .yachiyo(.ink)
        addressField.accessibilityLabel = String(localized: "Server address")
        addressField.accessibilityIdentifier = "device.editAddress.field"
        addressField.delegate = self
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: String(localized: "Save"), primaryAction: UIAction { [weak self] _ in self?.save() })
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "device.editAddress.save"
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        addressField.becomeFirstResponder()
    }

    override func numberOfSections(in _: UITableView) -> Int { 1 }
    override func tableView(_: UITableView, numberOfRowsInSection _: Int) -> Int { errorMessage == nil ? 1 : 2 }
    override func tableView(_: UITableView, titleForHeaderInSection _: Int) -> String? { String(localized: "Server address") }
    override func tableView(_: UITableView, titleForFooterInSection _: Int) -> String? {
        String(localized: "Paste the normal server URL from your Mac, not a pairing link. Saving keeps your pairing and reconnects to this address.")
    }

    override func tableView(_: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        cell.backgroundColor = .yachiyo(.surface)
        cell.selectionStyle = .none
        if indexPath.row == 0 {
            addressField.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.addSubview(addressField)
            NSLayoutConstraint.activate([
                addressField.leadingAnchor.constraint(equalTo: cell.contentView.layoutMarginsGuide.leadingAnchor),
                addressField.trailingAnchor.constraint(equalTo: cell.contentView.layoutMarginsGuide.trailingAnchor),
                addressField.topAnchor.constraint(equalTo: cell.contentView.topAnchor, constant: 14),
                addressField.bottomAnchor.constraint(equalTo: cell.contentView.bottomAnchor, constant: -14),
                addressField.heightAnchor.constraint(greaterThanOrEqualToConstant: 28),
            ])
        } else {
            var content = UIListContentConfiguration.cell()
            content.text = errorMessage
            content.textProperties.color = .yachiyo(.danger)
            content.textProperties.numberOfLines = 0
            cell.contentConfiguration = content
            cell.accessibilityIdentifier = "device.editAddress.error"
        }
        return cell
    }

    func textFieldShouldReturn(_: UITextField) -> Bool { save(); return false }

    private func save() {
        do {
            try RemoteStore.shared.updateAddress(desktopId: desktopId, address: addressField.text ?? "")
            dismiss(animated: true)
        } catch {
            errorMessage = error.localizedDescription
            tableView.reloadData()
            addressField.becomeFirstResponder()
            UIAccessibility.post(notification: .announcement, argument: errorMessage)
        }
    }
}
