import QuickLook
import UIKit
import YachiyoRemoteKit

/// Downloads through the paired RPC connection, then gives Quick Look a phone-local copy.
@MainActor
final class RemoteFilePreviewController: UIViewController, QLPreviewControllerDataSource {
    private let loadFile: (Bool) async throws -> RemoteFilePreviewCache.File
    private let temporaryDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    private var fileURL: URL?
    private var loadingTask: Task<Void, Never>?

    private let spinner = UIActivityIndicatorView(style: .large)
    private var preview: QLPreviewController?
    private var errorLabel: UILabel?

    init(loadFile: @escaping (Bool) async throws -> RemoteFilePreviewCache.File) {
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
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(refreshPreview))
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        load(refresh: false)
    }

    @objc private func refreshPreview() { load(refresh: true) }

    private func load(refresh: Bool) {
        loadingTask?.cancel()
        errorLabel?.removeFromSuperview()
        errorLabel = nil
        preview?.willMove(toParent: nil)
        preview?.view.removeFromSuperview()
        preview?.removeFromParent()
        preview = nil
        fileURL = nil
        spinner.isHidden = false
        spinner.startAnimating()
        navigationItem.leftBarButtonItem?.isEnabled = false
        let loader = loadFile
        loadingTask = Task { [weak self] in
            do {
                let file = try await loader(refresh)
                try Task.checkCancellation()
                guard let self else { return }
                let directory = temporaryDirectory
                let work = Task.detached(priority: .userInitiated) {
                    try Task.checkCancellation()
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let url = directory.appendingPathComponent(file.filename)
                    try file.data.write(to: url, options: .atomic)
                    return url
                }
                let url = try await withTaskCancellationHandler {
                    try await work.value
                } onCancel: {
                    work.cancel()
                }
                try Task.checkCancellation()
                fileURL = url
                title = url.lastPathComponent
                let preview = QLPreviewController()
                preview.dataSource = self
                addChild(preview)
                preview.view.frame = view.bounds
                preview.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(preview.view)
                preview.didMove(toParent: self)
                self.preview = preview
                spinner.stopAnimating()
                spinner.isHidden = true
                navigationItem.leftBarButtonItem?.isEnabled = true
            } catch is CancellationError {
                // Dismissing a preview must not present a late result.
            } catch {
                guard !Task.isCancelled else { return }
                guard let self else { return }
                spinner.stopAnimating()
                spinner.isHidden = true
                navigationItem.leftBarButtonItem?.isEnabled = true
                let label = UILabel()
                label.text = String(localized: "Unable to preview this file.") + "\n" + error.localizedDescription
                label.numberOfLines = 0
                label.textAlignment = .center
                label.translatesAutoresizingMaskIntoConstraints = false
                errorLabel = label
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
