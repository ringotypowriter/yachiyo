import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// One tool call's saved input and output. Loading and Refresh update the text in place, keeping
/// the reading position and an unaffected selection. Requests belong to this sheet: dismissing it
/// cancels them, and they only ever update this tool call's reader.
final class ToolPreviewViewController: UIViewController {
    private let thread: ThreadStore
    private let toolCallId: String
    private let store = RemoteStore.shared
    // TextKit 1, for glyph-level positions when the text is replaced.
    private let textView = UITextView(usingTextLayoutManager: false)
    private var document: ToolPreviewDocument?
    private var notice: String?
    private var isLoadingPreview = false
    private var loadTask: Task<Void, Never>?

    init(thread: ThreadStore, toolCallId: String) {
        self.thread = thread
        self.toolCallId = toolCallId
        super.init(nibName: nil, bundle: nil)
        title = thread.toolCall(toolCallId)?.toolName ?? String(localized: "Tool details")
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    deinit { loadTask?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .yachiyo(.canvas)
        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 32, right: 16)
        textView.accessibilityIdentifier = "toolPreview.body"
        textView.frame = view.bounds
        textView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(textView)
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: String(localized: "Refresh"), primaryAction: UIAction { [weak self] _ in
            self?.refresh()
        })
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "toolPreview.refresh"
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self]) { (reader: ToolPreviewViewController, _: UITraitCollection) in
            // Fonts and colors are resolved into the attributed text; rebuild it in place.
            reader.render(rebuildingText: true)
        }
        // Newer desktops leave previews out of `threads.load`; fetch this one on demand.
        if thread.needsToolPreview(toolCallId), store.link(for: thread.desktopId)?.state == .online {
            load { [thread, toolCallId] in
                await thread.loadToolPreview(toolCallId).map { String(localized: "Couldn't load the preview. \($0)") }
            }
        } else {
            render()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if navigationController?.isBeingDismissed ?? isBeingDismissed { loadTask?.cancel() }
    }

    private func refresh() {
        guard store.link(for: thread.desktopId)?.state == .online else {
            store.retryConnection(desktopId: thread.desktopId)
            notice = String(localized: "Updated preview unavailable while disconnected. Reconnecting to your Mac; tap Refresh when connected.")
            render()
            return
        }
        load { [thread, toolCallId] in
            // The reload brings the call's latest status and error; the preview has its own request.
            await thread.reload()
            if let error = thread.loadError { return error }
            guard thread.toolCall(toolCallId)?.hasPreview == true else { return nil }
            return await thread.loadToolPreview(toolCallId, refresh: true).map { String(localized: "Couldn't load the preview. \($0)") }
        }
    }

    /// Runs one request at a time; its result is the notice to show, nil when it succeeded.
    private func load(_ request: @escaping @MainActor () async -> String?) {
        guard loadTask == nil else { return }
        isLoadingPreview = true
        notice = nil
        navigationItem.leftBarButtonItem?.isEnabled = false
        render()
        loadTask = Task { [weak self] in
            let notice = await request()
            guard let self, !Task.isCancelled else { return }
            loadTask = nil
            isLoadingPreview = false
            self.notice = notice
            navigationItem.leftBarButtonItem?.isEnabled = true
            render()
        }
    }

    private func makeDocument() -> ToolPreviewDocument {
        let call = thread.toolCall(toolCallId)
        let preview = thread.toolPreview(toolCallId)
        var notices: [String] = []
        if let notice { notices.append(notice) }
        if preview.truncated {
            notices.append(String(localized: "This preview is shortened. The full result is on your Mac."))
        }
        if store.link(for: thread.desktopId)?.state != .online {
            notices.append(String(localized: "Offline — showing the saved preview."))
        }
        var sections: [ToolPreviewDocument.Section] = []
        if !notices.isEmpty { sections.append(.init(key: .notice, heading: nil, body: notices.joined(separator: "\n"))) }
        if let title = call?.title, !title.isEmpty { sections.append(.init(key: .title, heading: nil, body: title)) }
        if let input = preview.input {
            sections.append(.init(key: .input, heading: String(localized: "Input"), body: input))
        }
        let output = isLoadingPreview && preview.output == nil
            ? String(localized: "Loading preview…")
            : preview.output ?? String(localized: "No output preview is available yet.")
        sections.append(.init(key: .output, heading: String(localized: "Output"), body: output))
        if let error = call?.error {
            sections.append(.init(key: .error, heading: String(localized: "Error"), body: error))
        }
        return ToolPreviewDocument(sections: sections)
    }

    private func render(rebuildingText: Bool = false) {
        let next = makeDocument()
        guard rebuildingText || next != document else { return }
        let previous = document
        let position = previous.flatMap(readingPosition(in:))
        let selection = previous.flatMap { previous in next.carry(selection: textView.selectedRange, from: previous) }
        document = next
        textView.attributedText = attributedText(for: next)
        textView.selectedRange = selection ?? NSRange(location: 0, length: 0)
        if let previous, let position { restore(position, in: next, after: previous) }
    }

    private func attributedText(for document: ToolPreviewDocument) -> NSAttributedString {
        let text = NSMutableAttributedString(string: document.text, attributes: [
            .font: YachiyoFonts.body(),
            .foregroundColor: UIColor.yachiyo(.ink),
        ])
        let mono = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 14, weight: .regular))
        for key in [ToolPreviewDocument.Key.input, .output, .error] {
            if let range = document.bodyRange(of: key) { text.addAttribute(.font, value: mono, range: range) }
            if let range = document.headingRange(of: key) {
                text.addAttributes([.font: YachiyoFonts.sectionTitle(), .foregroundColor: UIColor.yachiyo(.textSecondary)], range: range)
            }
        }
        if let range = document.bodyRange(of: .notice) {
            text.addAttributes([.font: YachiyoFonts.meta(), .foregroundColor: UIColor.yachiyo(.textSecondary)], range: range)
        }
        return text
    }

    private struct ReadingPosition {
        let location: ToolPreviewDocument.Location
        /// How far the viewport's top sits below the top of that character's line.
        let lineOffset: CGFloat
    }

    /// Nil at the very top: new notices above should then come into view.
    private func readingPosition(in document: ToolPreviewDocument) -> ReadingPosition? {
        let top = textView.contentOffset.y + textView.adjustedContentInset.top
        guard top > 1 else { return nil }
        let layout = textView.layoutManager
        let point = CGPoint(x: 0, y: top - textView.textContainerInset.top)
        let glyph = layout.glyphIndex(for: point, in: textView.textContainer)
        let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        guard let location = document.location(at: layout.characterIndexForGlyph(at: glyph)) else { return nil }
        return ReadingPosition(location: location, lineOffset: point.y - line.minY)
    }

    private func restore(_ position: ReadingPosition, in document: ToolPreviewDocument, after previous: ToolPreviewDocument) {
        let layout = textView.layoutManager
        layout.ensureLayout(for: textView.textContainer)
        textView.layoutIfNeeded()
        let character = min(document.index(of: position.location, after: previous), max(0, document.text.utf16.count - 1))
        let glyph = layout.glyphIndexForCharacter(at: character)
        let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let minimum = -textView.adjustedContentInset.top
        let maximum = max(minimum, textView.contentSize.height - textView.bounds.height + textView.adjustedContentInset.bottom)
        let target = line.minY + position.lineOffset + textView.textContainerInset.top - textView.adjustedContentInset.top
        textView.contentOffset.y = min(max(target, minimum), maximum)
    }
}
