import UIKit
import YachiyoMaterial

/// Full-screen reading for plan documents and tool call details.
final class TextSheetViewController: UIViewController {
    private let text: String

    init(title: String, text: String) {
        self.text = text
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .yachiyo(.canvas)
        let textView = UITextView()
        textView.text = text
        textView.font = YachiyoFonts.body()
        textView.textColor = .yachiyo(.ink)
        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 32, right: 16)
        textView.accessibilityIdentifier = "textSheet.body"
        textView.frame = view.bounds
        textView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(textView)
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
    }
}
