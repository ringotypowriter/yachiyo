//
//  MessageListView.swift
//  LanguageModelChatUI
//
//  High-performance message list using ListViewKit.
//  Adapted from FlowDown's MessageListView.
//

import Combine
import ListViewKit
import Litext
import MarkdownView
import UIKit

private final class MessageTimelineListView: ListViewKit.ListView {
    override func touchesShouldCancel(in view: UIView) -> Bool {
        // Buttons remain tappable, but a drag must belong to the timeline.
        // Preserve UIKit's tracking policy for other controls (e.g. sliders).
        view is UIButton || super.touchesShouldCancel(in: view)
    }
}

public final class MessageListView: UIView {
    private lazy var listView = MessageTimelineListView()

    public var contentSize: CGSize {
        listView.contentSize
    }

    lazy var dataSource: ListViewDiffableDataSource<Entry> = .init(listView: listView)

    var selectedToolCalls: [String: String] = [:]
    var questionDrafts: [String: String] = [:]

    private var entryCount = 0
    private var isFirstLoad: Bool = true
    private let autoScrollTolerance: CGFloat = 2

    public var session: (any ChatMessageSource)? {
        didSet {
            selectedToolCalls.removeAll()
            questionDrafts.removeAll()
            isFirstLoad = true
            isAutoScrollingToBottom = true
            alpha = 0
            sessionScopedCancellables.forEach { $0.cancel() }
            sessionScopedCancellables.removeAll()
            guard let session else { return }
            Publishers.CombineLatest(
                session.messagesDidChange.prepend((session.messages, false)),
                loadingState
            )
            .receive(on: DispatchQueue.main)
            .sink { [weak self] v1, v2 in
                guard let self else { return }
                updateFromUpstreamPublisher(v1.0, v1.1, isLoading: v2)
            }
            .store(in: &sessionScopedCancellables)
            session.userDidSendMessage
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.isAutoScrollingToBottom = true
                }
                .store(in: &sessionScopedCancellables)
        }
    }

    private var isAutoScrollingToBottom: Bool = true {
        didSet {
            guard oldValue != isAutoScrollingToBottom else { return }
            interactionDelegate?.messageList(self, didChangeFollowingBottom: isAutoScrollingToBottom)
        }
    }
    private var sessionScopedCancellables: Set<AnyCancellable> = .init()
    let loadingState = CurrentValueSubject<String?, Never>(nil)

    var contentSafeAreaInsets: UIEdgeInsets = .zero {
        didSet { setNeedsLayout() }
    }

    static let listRowInsets: UIEdgeInsets = .init(top: 0, left: 20, bottom: 16, right: 20)

    var theme: MarkdownTheme = .default {
        didSet { listView.reloadData() }
    }

    /// Markdown styling for assistant text and the list's own rows (Yachiyo fork).
    public var markdownTheme: MarkdownTheme {
        get { theme }
        set { theme = newValue }
    }

    public weak var interactionDelegate: MessageListInteractionDelegate?

    /// Insets reserved for the navigation bar and the floating composer.
    public var contentInsets: UIEdgeInsets {
        get { contentSafeAreaInsets }
        set { contentSafeAreaInsets = newValue }
    }

    public var scrollView: UIScrollView { listView }

    public func scrollToBottom(animated: Bool) {
        isAutoScrollingToBottom = true
        if animated {
            listView.scroll(to: listView.maximumContentOffset)
        } else {
            listView.setContentOffset(listView.maximumContentOffset, animated: false)
        }
    }

    /// Scrolls until the question card with this tool call id is at the top of the list.
    public func scrollToQuestion(id: String) {
        let snapshot = dataSource.snapshot()
        var offset: CGFloat = 0
        for index in 0 ..< snapshot.count {
            guard let entry = snapshot.item(at: index) else { continue }
            if entry.id == "question-\(id)" {
                isAutoScrollingToBottom = false
                listView.scroll(to: CGPoint(x: 0, y: offset - contentSafeAreaInsets.top))
                return
            }
            offset += listView(listView, heightFor: entry, at: index)
        }
    }

    private(set) lazy var labelForSizeCalculation: LTXLabel = .init()
    private(set) lazy var markdownViewForSizeCalculation: MarkdownTextView = .init()
    private(set) lazy var markdownPackageCache: MarkdownPackageCache = .init()

    public init() {
        super.init(frame: .zero)

        listView.delegate = self
        listView.adapter = self
        listView.alwaysBounceVertical = true
        listView.alwaysBounceHorizontal = false
        listView.keyboardDismissMode = .interactive
        listView.delaysContentTouches = true
        listView.canCancelContentTouches = true
        listView.panGestureRecognizer.cancelsTouchesInView = true
        listView.contentInsetAdjustmentBehavior = .never
        listView.showsVerticalScrollIndicator = false
        listView.showsHorizontalScrollIndicator = false
        addSubview(listView)
        listView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            listView.topAnchor.constraint(equalTo: topAnchor),
            listView.bottomAnchor.constraint(equalTo: bottomAnchor),
            listView.leadingAnchor.constraint(equalTo: leadingAnchor),
            listView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])

    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError()
    }

    override public func layoutSubviews() {
        let wasNearBottom = isContentOffsetNearBottom()
        super.layoutSubviews()

        listView.contentInset = contentSafeAreaInsets

        if !listView.isTracking && !listView.isDecelerating && (isAutoScrollingToBottom || wasNearBottom) {
            let targetOffset = listView.maximumContentOffset
            if abs(listView.contentOffset.y - targetOffset.y) > autoScrollTolerance {
                listView.scroll(to: targetOffset)
            }
            if wasNearBottom {
                isAutoScrollingToBottom = true
            }
        }
    }

    private func updateAutoScrolling() {
        if isContentOffsetNearBottom() {
            isAutoScrollingToBottom = true
        }
    }

    private func isContentOffsetNearBottom(tolerance: CGFloat? = nil) -> Bool {
        let tolerance = tolerance ?? autoScrollTolerance
        return abs(listView.contentOffset.y - listView.maximumContentOffset.y) <= tolerance
    }

    func loading(with message: String = .init()) {
        loadingState.send(message)
    }

    func stopLoading() {
        loadingState.send(nil)
    }

    func updateList() {
        let entries = entries(from: session?.messages ?? [])
        dataSource.applySnapshot(using: entries, animatingDifferences: false)
    }

    func updateFromUpstreamPublisher(_ messages: [ConversationMessage], _ scrolling: Bool, isLoading: String?) {
        var entries = entries(from: messages)

        for entry in entries {
            switch entry {
            case let .responseContent(_, messageRepresentation):
                _ = markdownPackageCache.package(for: messageRepresentation, theme: theme)
            default: break
            }
        }

        if let isLoading { entries.append(.activityReporting(isLoading)) }

        let shouldScrolling = scrolling && isAutoScrollingToBottom

        entryCount = entries.count
        if isFirstLoad || alpha == 0 {
            isFirstLoad = false
            dataSource.applySnapshot(using: entries, animatingDifferences: false)
            listView.setContentOffset(.init(x: 0, y: listView.maximumContentOffset.y), animated: false)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                UIView.animate(withDuration: 0.25) { self.alpha = 1 }
            }
        } else {
            dataSource.applySnapshot(using: entries, animatingDifferences: true)
            if shouldScrolling {
                listView.scroll(to: listView.maximumContentOffset)
            }
        }
    }
}

extension MessageListView: UIScrollViewDelegate {
    public func scrollViewWillBeginDragging(_: UIScrollView) {
        isAutoScrollingToBottom = false
    }

    public func scrollViewDidEndDecelerating(_: UIScrollView) {
        updateAutoScrolling()
    }

    public func scrollViewDidEndDragging(_: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate {
            updateAutoScrolling()
        }
    }
}
