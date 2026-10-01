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
    var expandedToolDecks: Set<String> = []
    var expandedSummaryDecks: Set<String> = []
    var questionDrafts: [String: String] = [:]

    private var entryCount = 0
    private var isFirstLoad: Bool = true
    private let autoScrollTolerance: CGFloat = 2

    /// The latest upstream state not yet on screen. Updates that arrive while Markdown is being
    /// parsed replace it, so the list catches up with one apply instead of replaying each delta.
    private struct PendingUpdate {
        let messages: [ConversationMessage]
        let scrolling: Bool
        let isLoading: String?
        let earlierHistory: EarlierHistoryState
    }

    private var pendingUpdate: PendingUpdate?
    private var isParsingMarkdown = false
    private static let markdownParseQueue = DispatchQueue(label: "YachiyoChatUI.MarkdownParse", qos: .userInitiated)
    private var appliedEntryIDs: Set<String> = []
    private var appliedEntryOrder: [String] = []
    private var appliedContinuationIDs: Set<String> = []
    var responseChunkCache: [String: (text: String, chunks: [MarkdownChunker.Chunk])] = [:]

    /// While a spring scroll started by a structural change is settling, later deltas retarget
    /// it; afterwards following the bottom snaps, so content-only updates never start a spring.
    private var followSpringDeadline: CFTimeInterval = 0
    private static let followSpringDuration: CFTimeInterval = 1

    public var session: (any ChatMessageSource)? {
        didSet {
            selectedToolCalls.removeAll()
            expandedToolDecks.removeAll()
            expandedSummaryDecks.removeAll()
            questionDrafts.removeAll()
            pendingUpdate = nil
            responseChunkCache.removeAll()
            markdownPackageCache.removeAll()
            rowHeightCache.removeAll()
            isFirstLoad = true
            isAutoScrollingToBottom = true
            alpha = 0
            sessionScopedCancellables.forEach { $0.cancel() }
            sessionScopedCancellables.removeAll()
            guard let session else { return }
            Publishers.CombineLatest3(
                session.messagesDidChange.prepend((session.messages, false)),
                loadingState,
                earlierHistoryState
            )
            .receive(on: DispatchQueue.main)
            .sink { [weak self] v1, v2, v3 in
                guard let self else { return }
                updateFromUpstreamPublisher(v1.0, v1.1, isLoading: v2, earlierHistory: v3)
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
    private let earlierHistoryState = CurrentValueSubject<EarlierHistoryState, Never>(.none)
    private var hasRequestedEarlierHistory = false

    /// Shown as the first row unless `.none`. While `.available`, scrolling near the first
    /// loaded message requests the earlier page once.
    public var earlierHistory: EarlierHistoryState {
        get { earlierHistoryState.value }
        set {
            guard newValue != earlierHistoryState.value else { return }
            hasRequestedEarlierHistory = false
            earlierHistoryState.send(newValue)
        }
    }

    var contentSafeAreaInsets: UIEdgeInsets = .zero {
        didSet {
            guard oldValue != contentSafeAreaInsets else { return }
            setNeedsLayout()
        }
    }

    static let listRowInsets: UIEdgeInsets = .init(top: 0, left: 20, bottom: 16, right: 20)

    var theme: MarkdownTheme = .default {
        didSet {
            guard oldValue != theme else { return }
            markdownPackageCache.removeAll()
            chunkSpacing.removeAll()
            rowHeightCache.removeAll()
            listView.reloadData()
            // Chunk spacing is measured per theme; re-annotate what is on screen.
            if let session, !isFirstLoad {
                updateFromUpstreamPublisher(session.messages, false, isLoading: loadingState.value, earlierHistory: earlierHistory)
            }
        }
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
            startFollowSpring()
        } else {
            listView.cancelCurrentScrolling()
            listView.setContentOffset(listView.maximumContentOffset, animated: false)
        }
    }

    /// Scrolls until the question card with this tool call id is at the top of the list.
    public func scrollToQuestion(id: String) {
        let entryID = "question-\(id)"
        guard appliedEntryIDs.contains(entryID) else { return }
        isAutoScrollingToBottom = false
        let frame = listView.rectForRow(with: entryID)
        listView.scroll(to: CGPoint(x: 0, y: frame.minY - contentSafeAreaInsets.top))
    }

    private(set) lazy var labelForSizeCalculation: LTXLabel = .init()
    private(set) lazy var markdownViewForSizeCalculation: MarkdownTextView = .init()
    private(set) lazy var markdownPackageCache: MarkdownPackageCache = .init()
    private(set) lazy var chunkSpacing: ChunkSpacingCache = .init()
    private(set) lazy var rowHeightCache: RowHeightCache = .init()

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

        if listView.contentInset != contentSafeAreaInsets {
            listView.contentInset = contentSafeAreaInsets
        }

        if !listView.isTracking && !listView.isDecelerating && (isAutoScrollingToBottom || wasNearBottom) {
            followBottom(animated: true)
            if wasNearBottom {
                isAutoScrollingToBottom = true
            }
        }
    }

    /// The one follow-the-bottom path: a spring for structural changes and inset changes, a snap
    /// for content that grew in place.
    private func followBottom(animated: Bool) {
        let target = listView.maximumContentOffset
        let isSpringSettling = CACurrentMediaTime() < followSpringDeadline
        if isSpringSettling {
            // Retargets the running spring; no new display link, no restarted deadline.
            listView.scroll(to: target)
            return
        }
        guard abs(listView.contentOffset.y - target.y) > autoScrollTolerance else { return }
        if animated {
            startFollowSpring()
        } else {
            listView.cancelCurrentScrolling()
            listView.setContentOffset(target, animated: false)
        }
    }

    private func startFollowSpring() {
        followSpringDeadline = CACurrentMediaTime() + Self.followSpringDuration
        listView.scroll(to: listView.maximumContentOffset)
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

    func updateFromUpstreamPublisher(
        _ messages: [ConversationMessage], _ scrolling: Bool, isLoading: String?, earlierHistory: EarlierHistoryState
    ) {
        // A superseded update's request to follow the newest content still applies.
        let scrolling = scrolling || (pendingUpdate?.scrolling ?? false)
        pendingUpdate = PendingUpdate(messages: messages, scrolling: scrolling, isLoading: isLoading, earlierHistory: earlierHistory)
        drainPendingUpdate()
    }

    /// Parses changed response chunks off the main thread, then applies the newest pending state.
    /// Only `MarkdownParser.parse` is pure; packages, measuring and rows stay on the main thread.
    private func drainPendingUpdate() {
        guard let update = pendingUpdate else { return }
        var entries = entries(from: update.messages)
        let requests = markdownPackageCache.missingRequests(in: entries)
        if !requests.isEmpty {
            // One parse in flight; its completion drains whatever is newest by then.
            guard !isParsingMarkdown else { return }
            isParsingMarkdown = true
            let parser = markdownPackageCache.parser
            Self.markdownParseQueue.async { [weak self] in
                let parsed = requests.map { MarkdownPackageCache.Parsed(request: $0, result: parser.parse($0.content)) }
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    isParsingMarkdown = false
                    for item in parsed {
                        markdownPackageCache.store(item, theme: theme)
                    }
                    drainPendingUpdate()
                }
            }
            return
        }

        pendingUpdate = nil
        annotateChunkSpacing(&entries)
        if update.earlierHistory != .none { entries.insert(.earlierHistory(update.earlierHistory), at: 0) }
        if let isLoading = update.isLoading { entries.append(.activityReporting(isLoading)) }
        pruneResponseChunkCache(keeping: update.messages)
        apply(entries, scrolling: update.scrolling)
    }

    private func apply(_ entries: [Entry], scrolling: Bool) {
        let ids = Set(entries.map(\.id))
        let continuationIDs = Set(entries.compactMap { entry -> String? in
            guard case let .responseContent(_, chunk) = entry, chunk.isContinuation else { return nil }
            return entry.id
        })
        let previousIDs = appliedEntryIDs
        let previousContinuationIDs = appliedContinuationIDs
        let previousOrder = appliedEntryOrder
        let order = entries.map(\.id)
        appliedEntryIDs = ids
        appliedContinuationIDs = continuationIDs
        appliedEntryOrder = order
        pruneCaches(keeping: ids)

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
            // Only inserted or removed rows animate. Growing text (and the chunk rows it splits
            // into) applies in place, so streaming never stacks list springs.
            let isStructural = !ids.subtracting(previousIDs).subtracting(continuationIDs).isEmpty
                || !previousIDs.subtracting(ids).subtracting(previousContinuationIDs).isEmpty
            let anchor = readingAnchor(in: previousOrder, surviving: ids)
            // Rows inserted or removed above the anchor shift it; animating their layout would
            // show that shift before the offset correction lands.
            let shiftsAnchor = isStructural && anchor.map { anchor in
                order.prefix { $0 != anchor.id }.contains { !previousIDs.contains($0) }
                    || previousOrder.prefix { $0 != anchor.id }.contains { !ids.contains($0) }
            } ?? false
            dataSource.applySnapshot(using: entries, animatingDifferences: isStructural && !shiftsAnchor)
            if let anchor { restore(anchor) }
            if shouldScrolling {
                followBottom(animated: isStructural)
            }
        }
    }

    /// A row and where it sits in the viewport, so the same content stays under the reader's eyes
    /// when rows above it are inserted, removed or resized.
    private struct ReadingAnchor {
        let id: String
        let offsetInViewport: CGFloat
    }

    /// Rows that move or disappear with the history around them and so cannot hold a position.
    private static func holdsReadingPosition(_ id: String) -> Bool {
        id != Entry.earlierHistoryID && !id.hasPrefix("hint-") && !id.hasPrefix("activity-")
    }

    /// The first visible row that survives the update, else the nearest surviving row below or
    /// above the viewport.
    private func readingAnchor(in order: [String], surviving ids: Set<String>) -> ReadingAnchor? {
        let visible = listView.indicesForVisibleRows
        guard let firstVisible = visible.first, let lastVisible = visible.last, lastVisible < order.count else { return nil }
        func holds(_ index: Int) -> Bool {
            ids.contains(order[index]) && Self.holdsReadingPosition(order[index])
        }
        guard let index = visible.first(where: holds)
            ?? ((lastVisible + 1) ..< order.count).first(where: holds)
            ?? (0 ..< firstVisible).last(where: holds)
        else { return nil }
        return ReadingAnchor(id: order[index], offsetInViewport: listView.rectForRow(at: index).minY - listView.contentOffset.y)
    }

    private func restore(_ anchor: ReadingAnchor) {
        let current = listView.contentOffset.y
        let target = listView.rectForRow(with: anchor.id).minY - anchor.offsetInViewport
        // An unmoved anchor leaves the offset alone, including while it rubber-bands.
        guard abs(target - current) > 0.5 else { return }
        let bounds = listView.minimumContentOffset.y ... max(listView.minimumContentOffset.y, listView.maximumContentOffset.y)
        let clamped = min(max(target, bounds.lowerBound), bounds.upperBound)
        listView.cancelCurrentScrolling()
        if bounds.contains(current) {
            // Assigning the offset keeps a drag or deceleration going from the corrected position.
            listView.contentOffset.y = clamped
        } else {
            // A bounce would animate back to its stale target; end it at the corrected position.
            listView.setContentOffset(CGPoint(x: listView.contentOffset.x, y: clamped), animated: false)
        }
    }

    private func pruneCaches(keeping ids: Set<String>) {
        let limit = ids.count * 2 + 32
        if markdownPackageCache.count > limit { markdownPackageCache.prune(keeping: ids) }
        if rowHeightCache.count > limit { rowHeightCache.prune(keeping: ids) }
    }

    private func pruneResponseChunkCache(keeping messages: [ConversationMessage]) {
        guard responseChunkCache.count > messages.count * 2 + 32 else { return }
        let ids = Set(messages.map(\.id))
        responseChunkCache = responseChunkCache.filter { ids.contains($0.key) }
    }
}

extension MessageListView: UIScrollViewDelegate {
    public func scrollViewWillBeginDragging(_: UIScrollView) {
        isAutoScrollingToBottom = false
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Only the reader's own scrolling asks for more; the row's button covers everything else.
        guard earlierHistory == .available, !hasRequestedEarlierHistory, !isFirstLoad,
              scrollView.isTracking || scrollView.isDecelerating,
              scrollView.contentOffset.y - listView.minimumContentOffset.y < scrollView.bounds.height
        else { return }
        hasRequestedEarlierHistory = true
        interactionDelegate?.messageListDidRequestEarlierHistory(self)
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
