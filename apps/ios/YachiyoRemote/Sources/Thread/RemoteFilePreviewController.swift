import QuickLook
import UIKit

/// Downloads through the paired RPC connection, then gives Quick Look a phone-local copy.
@MainActor
final class RemoteFilePreviewController: UIViewController, QLPreviewControllerDataSource {
    private let loadFile: () async throws -> (filename: String, base64: String)
    private let temporaryDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    private var fileURL: URL?
    private var loadingTask: Task<Void, Never>?

    init(loadFile: @escaping () async throws -> (filename: String, base64: String)) {
        self.loadFile = loadFile
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    deinit {
        loadingTask?.cancel()
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = String(localized: "Preview")
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.loadingTask?.cancel()
            self?.dismiss(animated: true)
        })
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        spinner.startAnimating()
        let loader = loadFile
        loadingTask = Task { [weak self] in
            do {
                let file = try await loader()
                try Task.checkCancellation()
                guard let self else { return }
                guard let data = Data(base64Encoded: file.base64), data.count <= 6 * 1024 * 1024 else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                // Never trust a remote filename as a phone-local path.
                let filename = URL(fileURLWithPath: file.filename).lastPathComponent
                guard !filename.isEmpty, filename != ".", filename != ".." else { throw CocoaError(.fileReadInvalidFileName) }
                try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
                let url = temporaryDirectory.appendingPathComponent(filename)
                try data.write(to: url, options: .atomic)
                fileURL = url
                title = filename
                let preview = QLPreviewController()
                preview.dataSource = self
                addChild(preview)
                preview.view.frame = view.bounds
                preview.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(preview.view)
                preview.didMove(toParent: self)
                spinner.removeFromSuperview()
            } catch is CancellationError {
                // Dismissing a preview must not present a late result.
            } catch {
                guard let self else { return }
                spinner.removeFromSuperview()
                let label = UILabel()
                label.text = String(localized: "Unable to preview this file.") + "\n" + error.localizedDescription
                label.numberOfLines = 0
                label.textAlignment = .center
                label.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(label)
                NSLayoutConstraint.activate([
                    label.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
                    label.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
                    label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
                ])
            }
        }
    }

    func numberOfPreviewItems(in _: QLPreviewController) -> Int { fileURL == nil ? 0 : 1 }

    func previewController(_: QLPreviewController, previewItemAt _: Int) -> any QLPreviewItem {
        fileURL! as NSURL
    }
}
