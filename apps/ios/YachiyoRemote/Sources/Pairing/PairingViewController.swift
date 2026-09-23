import UIKit
import UniformTypeIdentifiers
import VisionKit
import YachiyoMaterial
import YachiyoRemoteKit

/// Pairing: welcome → scan (or a `yachiyo-remote://pair` link) → paired → optional iCloud folder
/// grant for address recovery. Deep links skip straight to pairing.
final class PairingViewController: UIViewController {
    var onFinished: (() -> Void)?

    private enum Step {
        case welcome
        case pairing
        case paired(DesktopSnapshot)
        case failed(String)
    }

    private let initialURL: URL?
    private let stack = UIStackView()
    private let avatar = UIImageView(image: UIImage(systemName: "sparkles"))
    private let headline = UILabel()
    private let wordmark = UILabel()
    private let message = UILabel()
    private let primaryButton = UIButton(type: .system)
    private let secondaryButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var step: Step = .welcome { didSet { render() } }

    init(initialURL: URL?) {
        self.initialURL = initialURL
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .yachiyo(.app)
        if RemoteStore.shared.hasDesktops {
            navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.onFinished?() })
        }
        layout()
        render()
        if let initialURL { pair(with: initialURL) }
    }

    private func layout() {
        avatar.contentMode = .scaleAspectFit
        avatar.tintColor = .yachiyo(.accent)
        avatar.backgroundColor = .yachiyo(.surface)
        avatar.layer.cornerRadius = 41
        avatar.layer.borderWidth = 7
        avatar.layer.borderColor = UIColor.yachiyo(.surface, alpha: 0.46).cgColor
        avatar.layer.shadowColor = YachiyoStyle.ink(0.14).cgColor
        avatar.layer.shadowOpacity = 1
        avatar.layer.shadowRadius = 19
        avatar.layer.shadowOffset = CGSize(width: 0, height: 18)
        avatar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([avatar.widthAnchor.constraint(equalToConstant: 82), avatar.heightAnchor.constraint(equalToConstant: 82)])

        headline.font = YachiyoFonts.display()
        headline.textColor = .yachiyo(.textSecondary)
        headline.textAlignment = .center
        headline.numberOfLines = 0
        wordmark.attributedText = NSAttributedString(string: "YACHIYO", attributes: [
            .font: YachiyoFonts.display(), .kern: 6, .foregroundColor: UIColor.yachiyo(.ink),
        ])
        message.font = YachiyoFonts.meta()
        message.textColor = .yachiyo(.textSecondary)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.accessibilityIdentifier = "pairing.message"
        primaryButton.accessibilityIdentifier = "pairing.primary"
        secondaryButton.accessibilityIdentifier = "pairing.secondary"

        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 14
        [avatar, headline, wordmark, spinner, message, primaryButton, secondaryButton].forEach(stack.addArrangedSubview)
        stack.setCustomSpacing(28, after: avatar)
        stack.setCustomSpacing(28, after: message)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -32),
            primaryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
        ])
    }

    private func render() {
        spinner.stopAnimating()
        primaryButton.isHidden = false
        secondaryButton.isHidden = false
        primaryButton.removeTarget(nil, action: nil, for: .allEvents)
        secondaryButton.removeTarget(nil, action: nil, for: .allEvents)
        switch step {
        case .welcome:
            headline.text = String(localized: "Creation with")
            wordmark.isHidden = false
            message.text = String(localized: "Open Settings > Remote in Yachiyo on your Mac, then scan the code.")
            setPrimary(String(localized: "Scan QR code")) { [weak self] in self?.startScanning() }
            setSecondary(String(localized: "Paste pairing link")) { [weak self] in self?.pastePairingLink() }
        case .pairing:
            headline.text = String(localized: "Pairing…")
            wordmark.isHidden = true
            message.text = nil
            spinner.startAnimating()
            primaryButton.isHidden = true
            secondaryButton.isHidden = true
        case let .paired(desktop):
            headline.text = String(localized: "Paired with \(desktop.name)")
            wordmark.isHidden = true
            if MailboxFolder.iCloudAvailable {
                message.text = String(localized: "If your Mac's address changes, Yachiyo finds it again through iCloud Drive. Choose the Yachiyo folder in iCloud Drive > Documents.")
                setPrimary(String(localized: "Choose iCloud folder")) { [weak self] in self?.chooseFolder() }
            } else {
                message.text = String(localized: "Turn on iCloud Drive in the Settings app (your name > iCloud) so Yachiyo can find your Mac after its address changes.")
                primaryButton.isHidden = true
            }
            setSecondary(String(localized: "Skip")) { [weak self] in self?.onFinished?() }
        case let .failed(reason):
            headline.text = String(localized: "Couldn't pair")
            wordmark.isHidden = true
            message.text = reason
            setPrimary(String(localized: "Scan QR code")) { [weak self] in self?.startScanning() }
            setSecondary(String(localized: "Paste pairing link")) { [weak self] in self?.pastePairingLink() }
        }
    }

    private func setPrimary(_ title: String, _ action: @escaping () -> Void) {
        var configuration = YachiyoMaterialKit.primaryButtonConfiguration(title: title, image: .lucide("qr-code"))
        configuration.baseBackgroundColor = .yachiyo(.accentFill)
        primaryButton.configuration = configuration
        primaryButton.tintColor = .yachiyo(.accent)
        primaryButton.addAction(UIAction { _ in action() }, for: .touchUpInside)
    }

    private func setSecondary(_ title: String, _ action: @escaping () -> Void) {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        secondaryButton.configuration = configuration
        secondaryButton.addAction(UIAction { _ in action() }, for: .touchUpInside)
    }

    // MARK: Actions

    private func pair(with url: URL) {
        step = .pairing
        Task {
            do {
                let desktop = try await RemoteStore.shared.pair(url: url)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                step = .paired(desktop)
            } catch let error as PairingURLError where error == .expired {
                step = .failed(String(localized: "This code has expired. Show a new one in Settings > Remote on your Mac."))
            } catch {
                step = .failed(String(localized: "This code has expired or was already used, or your Mac can't be reached. Show a new code in Settings > Remote on your Mac."))
            }
        }
    }

    private func startScanning() {
        guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else {
            pastePairingLink()
            return
        }
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = self
        scanner.view.layer.cornerRadius = 20
        present(scanner, animated: true) { try? scanner.startScanning() }
    }

    private func pastePairingLink() {
        let alert = UIAlertController(title: String(localized: "Paste pairing link"), message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "yachiyo-remote://pair?…"
            field.text = UIPasteboard.general.string
        }
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "Pair"), style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text, let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
            self?.pair(with: url)
        })
        present(alert, animated: true)
    }

    private func chooseFolder() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = self
        present(picker, animated: true)
    }
}

extension PairingViewController: DataScannerViewControllerDelegate {
    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
        for item in items {
            guard case let .barcode(code) = item, let payload = code.payloadStringValue,
                  let url = URL(string: payload), url.scheme == PairingURL.scheme
            else { continue }
            scanner.stopScanning()
            scanner.dismiss(animated: true) { self.pair(with: url) }
            return
        }
    }
}

extension PairingViewController: UIDocumentPickerDelegate {
    func documentPicker(_: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let folder = urls.first else { return }
        try? MailboxFolder.save(folder: folder)
        onFinished?()
    }
}
