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
    private let buttonActionID = UIAction.Identifier("pairing.action")
    private var isFinishingScan = false
    private var pairingTask: Task<Void, Never>?
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
            navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
                self?.cancelPairing()
                self?.onFinished?()
            })
        }
        layout()
        render()
        if let initialURL { pair(with: initialURL) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true {
            cancelPairing()
        }
    }

    private func layout() {
        headline.font = YachiyoFonts.display()
        headline.textColor = .yachiyo(.textSecondary)
        headline.textAlignment = .center
        headline.numberOfLines = 0
        headline.adjustsFontForContentSizeCategory = true
        headline.accessibilityTraits.insert(.header)
        wordmark.attributedText = NSAttributedString(string: "YACHIYO", attributes: [
            .font: YachiyoFonts.display(), .kern: 6, .foregroundColor: UIColor.yachiyo(.ink),
        ])
        message.font = YachiyoFonts.meta()
        message.textColor = .yachiyo(.textSecondary)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.adjustsFontForContentSizeCategory = true
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
        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        let content = UIView()
        content.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(content)
        content.addSubview(stack)
        let preferredHeight = content.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor)
        preferredHeight.priority = .defaultLow
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            content.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            content.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
            preferredHeight,
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -32),
            primaryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            secondaryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    private func render() {
        spinner.stopAnimating()
        primaryButton.isHidden = false
        secondaryButton.isHidden = false
        primaryButton.removeAction(identifiedBy: buttonActionID, for: .touchUpInside)
        secondaryButton.removeAction(identifiedBy: buttonActionID, for: .touchUpInside)
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
            message.text = String(localized: "Keep Yachiyo open while connecting to your Mac.")
            spinner.startAnimating()
            primaryButton.isHidden = true
            setSecondary(String(localized: "Cancel")) { [weak self] in self?.cancelPairing() }
        case let .paired(desktop):
            headline.text = String(localized: "Paired with \(desktop.name)")
            wordmark.isHidden = true
            message.text = String(localized: "You're ready to use your Mac. Optional: set up Address recovery in Settings to reconnect through iCloud Drive if your Mac's address changes. Without it, you may need to scan a new code.")
            setPrimary(String(localized: "Continue"), image: nil) { [weak self] in self?.onFinished?() }
            secondaryButton.isHidden = true
        case let .failed(reason):
            headline.text = String(localized: "Couldn't pair")
            wordmark.isHidden = true
            message.text = reason
            setPrimary(String(localized: "Scan QR code")) { [weak self] in self?.startScanning() }
            setSecondary(String(localized: "Paste pairing link")) { [weak self] in self?.pastePairingLink() }
        }
        if view.window != nil { UIAccessibility.post(notification: .screenChanged, argument: headline) }
    }

    private func setPrimary(_ title: String, image: UIImage? = .lucide("qr-code"), _ action: @escaping () -> Void) {
        var configuration = YachiyoMaterialKit.primaryButtonConfiguration(title: title, image: image)
        configuration.baseBackgroundColor = .yachiyo(.accentFill)
        primaryButton.configuration = configuration
        primaryButton.tintColor = .yachiyo(.accent)
        primaryButton.addAction(UIAction(identifier: buttonActionID) { _ in action() }, for: .touchUpInside)
    }

    private func setSecondary(_ title: String, _ action: @escaping () -> Void) {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        secondaryButton.configuration = configuration
        secondaryButton.addAction(UIAction(identifier: buttonActionID) { _ in action() }, for: .touchUpInside)
    }

    // MARK: Actions

    private func pair(with url: URL) {
        if case .pairing = step { return }
        do {
            _ = try PairingURL.decode(url)
        } catch PairingURLError.unsupportedVersion {
            step = .failed(String(localized: "This pairing link uses an unsupported version. Update Yachiyo on your iPhone and Mac, then copy a new link from Settings > Remote."))
            return
        } catch {
            step = .failed(String(localized: "This isn't a complete pairing link. Copy a new pairing link from Settings > Remote on your Mac, not the server address."))
            return
        }
        step = .pairing
        pairingTask = Task { [weak self] in
            do {
                let desktop = try await RemoteStore.shared.pair(url: url)
                guard !Task.isCancelled else { return }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                self?.pairingTask = nil
                self?.step = .paired(desktop)
            } catch {
                guard !Task.isCancelled else { return }
                self?.pairingTask = nil
                self?.step = .failed(String(localized: "This code has expired or was already used, or your Mac can't be reached. Show a new code in Settings > Remote on your Mac."))
            }
        }
    }

    private func cancelPairing() {
        guard pairingTask != nil else { return }
        pairingTask?.cancel()
        pairingTask = nil
        step = .welcome
    }

    private func startScanning() {
        guard presentedViewController == nil else { return }
        guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else {
            pastePairingLink()
            return
        }
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = self
        isFinishingScan = false
        scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self, weak scanner] _ in
            self?.isFinishingScan = true
            scanner?.stopScanning()
            self?.dismiss(animated: true)
        })
        let container = UINavigationController(rootViewController: scanner)
        present(container, animated: true) { [weak self, weak scanner] in
            guard let scanner else { return }
            do { try scanner.startScanning() }
            catch { self?.scannerUnavailable(scanner) }
        }
    }

    private func scannerUnavailable(_ scanner: DataScannerViewController) {
        guard !isFinishingScan else { return }
        isFinishingScan = true
        scanner.stopScanning()
        dismiss(animated: true) { [weak self] in
            self?.step = .failed(String(localized: "The camera couldn't scan a code. Check camera access in iPhone Settings, or paste a pairing link from your Mac."))
        }
    }

    private func pastePairingLink() {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(
            title: String(localized: "Paste pairing link"),
            message: String(localized: "On your Mac, open Settings > Remote > Copy pairing link. Use that link, not the server address."),
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.placeholder = "yachiyo-remote://pair?…"
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.spellCheckingType = .no
            field.smartQuotesType = .no
            field.smartDashesType = .no
            field.clearButtonMode = .whileEditing
            field.accessibilityLabel = String(localized: "Pairing link")
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
    func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError _: DataScannerViewController.ScanningUnavailable) {
        scannerUnavailable(scanner)
    }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
        guard !isFinishingScan else { return }
        for item in items {
            guard case let .barcode(code) = item, let payload = code.payloadStringValue,
                  let url = URL(string: payload), url.scheme == PairingURL.scheme
            else { continue }
            isFinishingScan = true
            scanner.stopScanning()
            dismiss(animated: true) { self.pair(with: url) }
            return
        }
    }
}
