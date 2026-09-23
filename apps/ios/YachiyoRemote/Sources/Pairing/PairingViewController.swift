import UIKit
import VisionKit
import YachiyoMaterial
import YachiyoRemoteKit

/// Pairing: welcome → scan (or a `yachiyo-remote://pair` link) → paired.
/// Optional address recovery is configured separately in Settings.
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
    private let avatar = BrandAvatarView()
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
            message.text = String(localized: "You're ready to use your Mac. Optional: set up Address recovery in Settings to reconnect through iCloud Drive if your Mac's address changes. Without it, you may need to scan a new code.")
            setPrimary(String(localized: "Continue")) { [weak self] in self?.onFinished?() }
            secondaryButton.isHidden = true
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
        let alert = UIAlertController(
            title: String(localized: "Paste pairing link"),
            message: String(localized: "On your Mac, open Settings > Remote > Copy pairing link. Use that link, not the server address."),
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.placeholder = "yachiyo-remote://pair?…"
            field.text = UIPasteboard.general.string
        }
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "Pair"), style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text,
                  let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
                  url.scheme == PairingURL.scheme, url.host == "pair"
            else {
                self?.step = .failed(String(localized: "This isn't a pairing link. Copy a new pairing link from Settings > Remote on your Mac, not the server address."))
                return
            }
            self?.pair(with: url)
        })
        present(alert, animated: true)
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
