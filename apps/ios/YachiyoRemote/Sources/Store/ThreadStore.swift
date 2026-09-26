import Combine
import Foundation
import UIKit
import YachiyoChatUI
import YachiyoRemoteKit

enum SendMode: String {
    case normal
    case steer
    case followUp = "follow-up"
}

enum ThreadOutboundState: Equatable {
    case idle, uploading, sending, accepted, queued, unconfirmed, rejected, offline
}

enum ThreadReplyState: Equatable {
    case idle, waiting, responding
}

/// The open thread: its loaded branch, live streaming state, and the actions the phone can
/// take. Implements `ChatMessageSource` so the forked message list renders it directly.
@MainActor
final class ThreadStore: ChatMessageSource {
    private static let maxFinishedRuns = 64
    private static let maxRunFooters = 8

    let desktopId: String
    let threadId: String
    private let store: RemoteStore
    // Include misses: remote-only images must not trigger disk reads on every streaming delta.
    private var imageData: [String: Data] = [:]
    private var missingImages: Set<String> = []
    private var loadingImages: Set<String> = []
    private var pendingSteerImages: [String: (runId: String, data: Data)] = [:]
    private var ambiguousSteerFilenames: Set<String> = []

    @Published private(set) var summary: RemoteThreadSummary?
    @Published private(set) var detail: RemoteThreadDetail? { didSet { toolCallsCache = nil } }
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    @Published private(set) var isStopping = false
    private var needsReload = true
    private var reloadAgain = false
    private var loadToken: UUID?
    private var isOpen = false
    private var cacheLoadTask: Task<Void, Never>?
    private var eventsDuringLoad: [(event: RemoteEvent, seq: Int)] = []
    private var loadEventsOverflowed = false
    private var isReplayingLoadEvents = false
    private var deltaRebuildTask: Task<Void, Never>?
    private var pendingRebuildScrolls = false
    @Published private(set) var lastError: String?
    @Published private(set) var outboundState: ThreadOutboundState = .idle
    @Published private(set) var replyState: ThreadReplyState = .idle
    private var respondingRunIds: Set<String> = []
    /// Oldest first; bounded, since only recent runs can still send late events.
    private var finishedRunIds: [String] = []
    var isSending: Bool { outboundState == .uploading || outboundState == .sending }

    /// Messages streaming in the active run (message id → accumulated text / reasoning).
    private var streamingText: [String: String] = [:]
    private var streamingReasoning: [String: String] = [:]
    private var streamingParent: [String: String] = [:]
    private var streamingOrder: [String] = []
    /// Captured once per streaming message so its rows keep a stable identity.
    private var streamingCreatedAt: [String: Date] = [:]
    private var activeRunObservedAt = Date()
    private var liveToolCalls: [String: RemoteToolCall] = [:] { didSet { toolCallsCache = nil } }
    private var toolCallsCache: [RemoteToolCall]?
    /// Previews fetched on demand when `threads.load` omitted them.
    private var toolPreviews: [String: RemoteToolsGetPreviewOutput] = [:]
    /// Assistant message id → the run that produced it, learned from stream events.
    private var messageRunIds: [String: String] = [:]
    private struct RunFooter {
        let runId: String
        let text: String
        let createdAt: Date
    }
    /// Oldest first; a footer attaches only to a message of its own run.
    private var runFooters: [RunFooter] = []
    /// A terminal run with no message to carry its footer (for example, it failed before
    /// replying) shows the footer on its own row until the next run or send.
    private var standaloneFooterRunId: String?
    private var pendingPlanContent: String?
    private var planReadToken: UUID?
    private var activeRunId: String?
    private var cancellables: Set<AnyCancellable> = []

    private struct BuiltMessage {
        let source: RemoteMessage
        let toolCalls: [RemoteToolCall]
        let images: [Bool]
        let footer: String?
        let message: ConversationMessage
    }
    /// Loaded, non-streaming messages are rebuilt only when one of their inputs changes.
    private var builtMessages: [String: BuiltMessage] = [:]

    private(set) var messages: [ConversationMessage] = []
    private let messagesSubject = PassthroughSubject<([ConversationMessage], Bool), Never>()
    private let userSentSubject = PassthroughSubject<Void, Never>()
    var messagesDidChange: AnyPublisher<([ConversationMessage], Bool), Never> { messagesSubject.eraseToAnyPublisher() }
    var userDidSendMessage: AnyPublisher<Void, Never> { userSentSubject.eraseToAnyPublisher() }

    // `store` defaults inside the body: a `= .shared` default argument is evaluated outside the
    // main actor.
    init(desktopId: String, threadId: String, store: RemoteStore? = nil) {
        let store = store ?? .shared
        self.desktopId = desktopId
        self.threadId = threadId
        self.store = store
        summary = store.summary(desktopId: desktopId, threadId: threadId)
        rebuild(scrolling: false)
        // The history file is read off the main thread; reloads wait for it (see reloadIfNeeded).
        cacheLoadTask = Task { [weak self] in
            let cached = await store.cachedThread(desktopId: desktopId, threadId: threadId)
            self?.applyCached(cached)
        }
        store.threadEvents
            .filter { [desktopId, threadId] in $0.desktopId == desktopId && $0.event.threadId == threadId }
            .sink { [weak self] in self?.apply($0.event, seq: $0.seq) }
            .store(in: &cancellables)
        store.resyncs
            .filter { [desktopId] in $0 == desktopId }
            .sink { [weak self] _ in self?.invalidate() }
            .store(in: &cancellables)
        store.$desktops
            .map { [desktopId] in $0.first { $0.id == desktopId }?.state }
            .removeDuplicates()
            .sink { [weak self] state in
                guard let self, isOpen else { return }
                if state == .online { Task { await self.reloadIfNeeded() } }
                else {
                    if loadToken != nil || planReadToken != nil { needsReload = true }
                    planReadToken = nil
                    loadToken = nil; isLoading = false; eventsDuringLoad.removeAll()
                }
            }
            .store(in: &cancellables)
        store.summaryUpdates
            .filter { [desktopId, threadId] in $0.desktopId == desktopId && $0.summary.id == threadId }
            .sink { [weak self] update in
                guard let self, summary != update.summary else { return }
                summary = update.summary
            }
            .store(in: &cancellables)
    }

    private func applyCached(_ cached: RemoteCachedThread?) {
        cacheLoadTask = nil
        // A network snapshot that already arrived is newer than anything on disk.
        guard let cached, detail == nil else { return }
        detail = cached.detail
        if activeRunId == nil, let runId = cached.detail.activeRunId, !finishedRunIds.contains(runId) { activeRunId = runId }
        updateReplyState()
        needsReload = cached.needsRefresh || activeRunId != nil
        if summary == nil { summary = cached.detail.thread }
        rebuild(scrolling: false)
    }

    /// Resolves once the cached history (if any) is applied. The list positions itself at the
    /// bottom on its first content, so it attaches after this.
    func waitForCachedHistory() async {
        if let cacheLoadTask { await cacheLoadTask.value }
    }

    var isRunning: Bool { activeRunId != nil }
    var pendingQuestion: RemoteToolCall? {
        allToolCalls.first { $0.status == .waitingForUser && $0.question != nil }
    }
    var queuedFollowUps: [RemoteMessage] { detail?.queuedFollowUps ?? [] }
    var isReadOnly: Bool { summary?.isReadOnly ?? false }

    /// Loaded and live tool calls by start time, computed once per change.
    private var allToolCalls: [RemoteToolCall] {
        if let toolCallsCache { return toolCallsCache }
        var byId = Dictionary((detail?.toolCalls ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        for (id, call) in liveToolCalls { byId[id] = call }
        let sorted = byId.values.sorted { $0.startedAt < $1.startedAt }
        toolCallsCache = sorted
        return sorted
    }

    func message(for id: String) -> ConversationMessage? {
        messages.first { $0.id == id }
    }

    func notifyMessagesDidChange(scrolling: Bool) {
        messagesSubject.send((messages, scrolling))
    }

    // MARK: Loading

    func open() async {
        guard !Task.isCancelled else { return }
        isOpen = true
        store.setOpenThread(desktopId: desktopId, threadId: threadId)
        await reloadIfNeeded()
    }

    func close() {
        deltaRebuildTask?.cancel()
        deltaRebuildTask = nil
        isOpen = false
        needsReload = true
        planReadToken = nil
        loadToken = nil
        isLoading = false
        eventsDuringLoad.removeAll()
        loadEventsOverflowed = false
        store.clearOpenThread(desktopId: desktopId, threadId: threadId)
    }

    private func invalidate() {
        needsReload = true
        store.dirtyThread(desktopId: desktopId, threadId: threadId)
        if loadToken != nil { reloadAgain = true }
        else if isOpen { Task { await self.reloadIfNeeded() } }
    }

    private func reloadIfNeeded() async {
        // A fresh cached history makes the network load unnecessary.
        if let cacheLoadTask { await cacheLoadTask.value }
        guard needsReload || detail == nil else { return }
        await reload(force: false)
    }

    func reload(force: Bool = true) async {
        guard isOpen, let link = store.link(for: desktopId), link.state == .online else { return }
        // Opening a scope must complete before its snapshot request starts.
        guard await link.waitForWatch(threadId: threadId), isOpen, !Task.isCancelled else { return }
        guard loadToken == nil, force || needsReload || detail == nil else { return }
        needsReload = true
        store.dirtyThread(desktopId: desktopId, threadId: threadId)
        reloadAgain = false
        let token = UUID()
        planReadToken = nil
        loadToken = token
        eventsDuringLoad.removeAll()
        loadEventsOverflowed = false
        let initialLoad = detail == nil
        isLoading = true
        loadError = nil
        var completed = false
        defer {
            if loadToken == token || completed {
                loadToken = nil
                isLoading = false
                eventsDuringLoad.removeAll()
                if reloadAgain, isOpen {
                    reloadAgain = false
                    Task { await self.reloadIfNeeded() }
                }
            }
        }
        do {
            // Previews are fetched when a tool call is opened; older desktops ignore the flag.
            let loaded: RemoteThreadDetail = try await store.call(desktopId, "threads.load", ThreadLoadInput(threadId: threadId, limit: 50, beforeMessageId: nil, omitToolPreviews: true))
            guard loadToken == token, isOpen, !loadEventsOverflowed, !Task.isCancelled else { return }
            cacheLoadTask?.cancel()
            cacheLoadTask = nil
            pendingPlanContent = nil
            detail = loaded
            if summary != loaded.thread { summary = loaded.thread }
            store.upsert(desktopId: desktopId, summary: loaded.thread)
            activeRunId = loaded.activeRunId.flatMap { finishedRunIds.contains($0) ? nil : $0 }
            updateReplyState()
            clearStreaming()
            toolPreviews = toolPreviews.filter { id, _ in loaded.toolCalls.contains { $0.id == id } }
            let buffered = eventsDuringLoad
            needsReload = reloadAgain
            store.cacheThread(desktopId: desktopId, detail: loaded, needsRefresh: !buffered.isEmpty || reloadAgain)
            completed = true
            loadToken = nil
            isLoading = false
            eventsDuringLoad.removeAll()
            isReplayingLoadEvents = true
            for entry in buffered where entry.seq > (loaded.streamSnapshotSeq ?? -1) {
                apply(entry.event, seq: entry.seq)
            }
            isReplayingLoadEvents = false
            let loadedMessages = detail?.messages ?? []
            let uniqueFilenames = loadedMessages.flatMap(\.images).compactMap(\.filename)
            let counts = Dictionary(uniqueFilenames.map { ($0, 1) }, uniquingKeysWith: +)
            let allowedFilenames = Set(counts.compactMap { $0.value == 1 ? $0.key : nil })
            for message in loadedMessages {
                materializeSteerImages(in: message, allowedFilenames: allowedFilenames)
            }
            // A terminal snapshot without the steer means it was withdrawn or cancelled.
            if loaded.activeRunId == nil && buffered.isEmpty {
                pendingSteerImages.removeAll()
                ambiguousSteerFilenames.removeAll()
                let (desktopId, threadId) = (desktopId, threadId)
                SentImages.queue.async { try? SentImages.store.removePending(desktopId: desktopId, threadId: threadId) }
            }
            let visibleImageKeys = Set((detail?.messages ?? []).flatMap { message in
                message.images.map { imageKey(messageId: message.id, imageId: $0.imageId) }
            } + (detail?.queuedFollowUps ?? []).flatMap { message in
                message.images.map { imageKey(messageId: message.id, imageId: $0.imageId) }
            })
            imageData = imageData.filter { visibleImageKeys.contains($0.key) }
            missingImages = missingImages.intersection(visibleImageKeys)
            let knownMessages = Set(loadedMessages.map(\.id))
            messageRunIds = messageRunIds.filter { knownMessages.contains($0.key) }
            rebuild(scrolling: initialLoad)
            if loaded.pendingPlan, detail?.pendingPlan == true, isOpen {
                // The file-backed preview is optional; do not delay history or review actions.
                planReadToken = token
                Task { [weak self] in
                    guard let self, isOpen, planReadToken == token, !Task.isCancelled else { return }
                    let plan: RemotePlanReadOutput? = try? await store.call(desktopId, "plan.read", ThreadRefInput(threadId: threadId))
                    guard isOpen, planReadToken == token, detail?.pendingPlan == true,
                          !Task.isCancelled, let plan else { return }
                    planReadToken = nil
                    pendingPlanContent = plan.content
                    rebuild(scrolling: false)
                }
            }
        } catch {
            guard loadToken == token, !Task.isCancelled, !(error is CancellationError) else { return }
            loadError = describe(error)
        }
    }

    // MARK: Events

    private func updateReplyState() {
        let next: ThreadReplyState
        if let activeRunId { next = respondingRunIds.contains(activeRunId) ? .responding : .waiting }
        else { next = .idle }
        if replyState != next { replyState = next }
    }

    private func clearStreaming() {
        streamingText.removeAll()
        streamingReasoning.removeAll()
        streamingParent.removeAll()
        streamingOrder.removeAll()
        streamingCreatedAt.removeAll()
        liveToolCalls.removeAll()
    }

    private func observeRun(_ runId: String?, responding: Bool = false) {
        guard let runId, !finishedRunIds.contains(runId) else { return }
        if activeRunId != runId {
            // A new run must not attach its tools to a previous run's unfinished bubble.
            clearStreaming()
            activeRunId = runId
            activeRunObservedAt = Date()
            standaloneFooterRunId = nil
        }
        if responding { respondingRunIds.insert(runId) }
        updateReplyState()
    }

    private func finishRun(_ runId: String) {
        if !finishedRunIds.contains(runId) {
            finishedRunIds.append(runId)
            if finishedRunIds.count > Self.maxFinishedRuns { finishedRunIds.removeFirst() }
        }
        respondingRunIds.remove(runId)
    }

    private func beginStreaming(_ messageId: String, runId: String?) {
        if let runId { messageRunIds[messageId] = runId }
        guard streamingText[messageId] == nil else { return }
        streamingText[messageId] = detail?.messages.first { $0.id == messageId }?.content ?? ""
        streamingCreatedAt[messageId] = Date()
        streamingOrder.append(messageId)
    }

    private func apply(_ event: RemoteEvent, seq: Int) {
        guard isOpen else { return }
        if loadToken != nil, !loadEventsOverflowed {
            if eventsDuringLoad.count < 256 { eventsDuringLoad.append((event, seq)) }
            else {
                eventsDuringLoad.removeAll()
                loadEventsOverflowed = true
                reloadAgain = true
            }
        }
        switch event.type {
        case .messageStarted:
            guard let messageId = event.messageId else { return }
            observeRun(event.runId)
            beginStreaming(messageId, runId: event.runId)
            if let parent = event.parentMessageId { streamingParent[messageId] = parent }
            scheduleDeltaRebuild()
        case .messageDelta:
            guard let messageId = event.messageId else { return }
            observeRun(event.runId ?? activeRunId, responding: true)
            beginStreaming(messageId, runId: event.runId ?? activeRunId)
            streamingText[messageId, default: ""] += event.delta ?? ""
            scheduleDeltaRebuild()
        case .messageReasoningDelta:
            guard let messageId = event.messageId else { return }
            observeRun(event.runId ?? activeRunId, responding: true)
            beginStreaming(messageId, runId: event.runId ?? activeRunId)
            if streamingReasoning[messageId] == nil {
                streamingReasoning[messageId] = detail?.messages.first { $0.id == messageId }?.reasoning ?? ""
            }
            streamingReasoning[messageId, default: ""] += event.delta ?? ""
            scheduleDeltaRebuild()
        case .messageCompleted:
            guard let message = event.message else { return }
            if message.role == .user { materializeSteerImages(in: message, runId: event.runId) }
            if message.role == .assistant, let runId = event.runId { messageRunIds[message.id] = runId }
            upsertLoaded(message)
            streamingText[message.id] = nil
            streamingReasoning[message.id] = nil
            streamingCreatedAt[message.id] = nil
            streamingOrder.removeAll { $0 == message.id }
            rebuild(scrolling: true)
        case .toolUpdated:
            guard let toolCall = event.toolCall else { return }
            observeRun(event.runId ?? toolCall.runId, responding: true)
            if liveToolCalls[toolCall.id] != toolCall {
                liveToolCalls[toolCall.id] = toolCall
                scheduleDeltaRebuild()
            }
        case .runStatus:
            guard let runId = event.runId, let status = event.status else { return }
            if status == .running {
                observeRun(runId)
            } else {
                finishRun(runId)
                if activeRunId == runId { activeRunId = nil }
                updateReplyState()
                runFooters.removeAll { $0.runId == runId }
                let footer: String?
                switch status {
                case .cancelled: footer = String(localized: "Stopped")
                case .failed: footer = String(localized: "Failed: \(event.error ?? "")")
                default: footer = nil
                }
                if let footer {
                    runFooters.append(RunFooter(runId: runId, text: footer, createdAt: Date()))
                    if runFooters.count > Self.maxRunFooters { runFooters.removeFirst() }
                    standaloneFooterRunId = runId
                }
                // The finished branch (sibling ids, final tool summaries) comes from a reload.
                if !isReplayingLoadEvents { invalidate() }
            }
            rebuild(scrolling: false)
        case .threadInvalidated:
            if !isReplayingLoadEvents { invalidate() }
        case .threadRemoved:
            planReadToken = nil
            imageData.removeAll()
            missingImages.removeAll()
            pendingSteerImages.removeAll()
            ambiguousSteerFilenames.removeAll()
            loadToken = nil
            reloadAgain = false
            needsReload = false
            isLoading = false
            eventsDuringLoad.removeAll()
            detail = nil
            summary = nil
            activeRunId = nil
            updateReplyState()
            clearStreaming()
            rebuild(scrolling: false)
        default:
            // Todos are not rendered; `todo.updated` needs no rebuild.
            break
        }
    }

    private func upsertLoaded(_ message: RemoteMessage) {
        guard let current = detail else { return }
        var list = current.messages
        if let index = list.firstIndex(where: { $0.id == message.id }) {
            list[index] = message
        } else {
            list.append(message)
        }
        if message.role == .user { standaloneFooterRunId = nil }
        detail = current.replacing(messages: list)
        if let detail { store.cacheThread(desktopId: desktopId, detail: detail, needsRefresh: true) }
    }

    // MARK: Timeline

    /// Coalesces bursts (deltas, tool updates, image loads) into one rebuild per 16 ms.
    private func scheduleDeltaRebuild(scrolling: Bool = true) {
        pendingRebuildScrolls = pendingRebuildScrolls || scrolling
        guard deltaRebuildTask == nil, !isReplayingLoadEvents else { return }
        deltaRebuildTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
            guard let self, isOpen else { return }
            deltaRebuildTask = nil
            rebuild(scrolling: pendingRebuildScrolls)
        }
    }

    private func rebuild(scrolling: Bool) {
        deltaRebuildTask?.cancel()
        deltaRebuildTask = nil
        pendingRebuildScrolls = false
        guard !isReplayingLoadEvents else { return }
        let toolCalls = allToolCalls
        let loaded = detail?.messages ?? []
        let callsByMessage = Dictionary(grouping: toolCalls.filter { $0.assistantMessageId != nil }) { $0.assistantMessageId! }
        let loadedIds = Set(loaded.map(\.id))
        let unattached = toolCalls.filter { call in
            call.runId == activeRunId && activeRunId != nil && (call.assistantMessageId == nil || !loadedIds.contains(call.assistantMessageId!))
        }
        let footers = footersByMessage(loaded: loaded, callsByMessage: callsByMessage)
        var built: [ConversationMessage] = []
        var retained: [String: BuiltMessage] = [:]

        for message in loaded {
            let calls = callsByMessage[message.id] ?? []
            let footer = footers.byMessage[message.id]
            let previous = builtMessages[message.id]
            let createdAt = previous?.source.createdAt == message.createdAt ? previous!.message.createdAt : (message.createdAt.isoDate ?? Date())
            if let text = streamingText[message.id] {
                built.append(conversationMessage(
                    id: message.id, role: message.role == .user ? .user : .assistant,
                    text: text, reasoning: streamingReasoning[message.id] ?? message.reasoning,
                    reasoningCollapsed: true, createdAt: createdAt,
                    attachments: message.attachments.map(\.filename), toolCalls: calls,
                    siblings: message.siblingIds, plan: message.isPlanDocument ? "accepted" : nil,
                    images: message.images, footer: footer
                ))
                continue
            }
            let images = message.images.map { retainedImage(messageId: message.id, imageId: $0.imageId) != nil }
            if let previous, previous.source == message, previous.toolCalls == calls,
               previous.images == images, previous.footer == footer {
                retained[message.id] = previous
                built.append(previous.message)
                continue
            }
            let conversation = conversationMessage(
                id: message.id, role: message.role == .user ? .user : .assistant,
                text: message.content, reasoning: message.reasoning,
                reasoningCollapsed: true, createdAt: createdAt,
                attachments: message.attachments.map(\.filename), toolCalls: calls,
                siblings: message.siblingIds, plan: message.isPlanDocument ? "accepted" : nil,
                images: message.images, footer: footer
            )
            retained[message.id] = BuiltMessage(source: message, toolCalls: calls, images: images, footer: footer, message: conversation)
            built.append(conversation)
        }
        builtMessages = retained

        for (index, id) in streamingOrder.enumerated() where !loadedIds.contains(id) {
            let isLast = index == streamingOrder.count - 1
            built.append(conversationMessage(
                id: id,
                role: .assistant,
                text: streamingText[id] ?? "",
                reasoning: streamingReasoning[id],
                reasoningCollapsed: !(streamingText[id] ?? "").isEmpty,
                createdAt: streamingCreatedAt[id] ?? activeRunObservedAt,
                attachments: [],
                toolCalls: isLast ? unattached : [],
                siblings: nil,
                plan: nil,
                footer: footers.byMessage[id]
            ))
        }
        if streamingOrder.isEmpty, !unattached.isEmpty {
            built.append(conversationMessage(
                id: "run-\(activeRunId ?? "")", role: .assistant, text: "", reasoning: nil, reasoningCollapsed: true,
                createdAt: activeRunObservedAt, attachments: [], toolCalls: unattached, siblings: nil, plan: nil
            ))
        }
        if let standalone = footers.standalone {
            built.append(conversationMessage(
                id: "run-\(standalone.runId)", role: .assistant, text: "", reasoning: nil, reasoningCollapsed: true,
                createdAt: standalone.createdAt, attachments: [], toolCalls: [], siblings: nil, plan: nil,
                footer: standalone.text
            ))
        }
        // The current file-backed plan is independent of historical marker messages.
        // Never offer an old document for acceptance when reading the current file fails.
        if detail?.pendingPlan == true {
            built.append(conversationMessage(
                id: "pending-plan-\(threadId)", role: .assistant,
                text: pendingPlanContent ?? String(localized: "The plan is ready for review."),
                reasoning: nil, reasoningCollapsed: true,
                createdAt: detail?.thread.updatedAt.isoDate ?? Date(),
                attachments: [], toolCalls: [], siblings: nil, plan: "pending"
            ))
        }
        messages = built
        messagesSubject.send((built, scrolling))
    }

    /// Each footer belongs to its run: it goes on the last assistant message that run produced,
    /// never on a later reply.
    private func footersByMessage(
        loaded: [RemoteMessage], callsByMessage: [String: [RemoteToolCall]]
    ) -> (byMessage: [String: String], standalone: RunFooter?) {
        guard !runFooters.isEmpty else { return ([:], nil) }
        func runId(of messageId: String) -> String? {
            messageRunIds[messageId] ?? callsByMessage[messageId]?.lazy.compactMap(\.runId).first
        }
        let assistantIds = loaded.filter { $0.role == .assistant }.map(\.id)
            + streamingOrder.filter { id in !loaded.contains { $0.id == id } }
        var lastByRun: [String: String] = [:]
        for id in assistantIds { if let run = runId(of: id) { lastByRun[run] = id } }
        var byMessage: [String: String] = [:]
        var standalone: RunFooter?
        for footer in runFooters {
            if let messageId = lastByRun[footer.runId] { byMessage[messageId] = footer.text }
            else if footer.runId == standaloneFooterRunId, activeRunId == nil { standalone = footer }
        }
        return (byMessage, standalone)
    }

    private func conversationMessage(
        id: String,
        role: MessageRole,
        text: String,
        reasoning: String?,
        reasoningCollapsed: Bool,
        createdAt: Date,
        attachments: [String],
        toolCalls: [RemoteToolCall],
        siblings: [String]?,
        plan: String?,
        images: [RemoteImageRef] = [],
        footer: String? = nil
    ) -> ConversationMessage {
        var parts: [ContentPart] = []
        if let reasoning, !reasoning.isEmpty {
            parts.append(.reasoning(ReasoningContentPart(id: "\(id)-reasoning", text: reasoning, isCollapsed: reasoningCollapsed)))
        }
        for call in toolCalls {
            if let question = call.question {
                parts.append(.question(QuestionContentPart(
                    id: call.id,
                    runId: call.runId ?? "",
                    question: question.question,
                    choices: question.choices ?? [],
                    answer: question.answer,
                    isWaiting: call.status == .waitingForUser
                )))
            } else {
                parts.append(.toolCall(ToolCallContentPart(
                    id: call.id,
                    toolName: call.toolName,
                    parameters: call.title,
                    state: call.status == .failed ? .failed : (call.status == .completed ? .succeeded : .running)
                )))
            }
        }
        parts.append(.text(TextContentPart(id: "\(id)-text", text: text)))
        for name in attachments {
            parts.append(.file(FileContentPart(mediaType: "application/octet-stream", data: Data(), textContent: name, name: name)))
        }
        for image in images {
            let data = retainedImage(messageId: id, imageId: image.imageId) ?? Data()
            if data.isEmpty {
                let name = image.filename ?? "image"
                parts.append(.file(FileContentPart(mediaType: image.mediaType, data: Data(), textContent: name, name: name)))
            } else {
                parts.append(.image(ImageContentPart(
                    id: "\(id)-image-\(image.imageId)", mediaType: image.mediaType,
                    data: data, name: image.filename ?? "image.jpeg"
                )))
            }
        }
        var metadata: [String: String] = [:]
        if let siblings, siblings.count > 1, let index = siblings.firstIndex(of: id) {
            metadata[MessageMetadataKey.siblingIndex] = String(index)
            metadata[MessageMetadataKey.siblingCount] = String(siblings.count)
        }
        if let plan { metadata[MessageMetadataKey.plan] = plan }
        if let footer { metadata[MessageMetadataKey.footer] = footer }
        return ConversationMessage(id: id, conversationID: threadId, role: role, parts: parts, createdAt: createdAt, metadata: metadata)
    }

    private func imageKey(messageId: String, imageId: String) -> String {
        "\(messageId.utf8.count):\(messageId)\(imageId)"
    }

    /// Returns what is in memory and starts a background read on the first miss; the timeline
    /// rebuilds when the file arrives.
    private func retainedImage(messageId: String, imageId: String) -> Data? {
        let key = imageKey(messageId: messageId, imageId: imageId)
        if let data = imageData[key] { return data }
        guard !missingImages.contains(key), loadingImages.insert(key).inserted else { return nil }
        let (desktopId, threadId) = (desktopId, threadId)
        SentImages.queue.async { [weak self] in
            let data = SentImages.store.load(desktopId: desktopId, threadId: threadId, messageId: messageId, imageId: imageId)
            DispatchQueue.main.async { [weak self] in
                guard let self, loadingImages.remove(key) != nil else { return }
                if let data {
                    imageData[key] = data
                    scheduleDeltaRebuild(scrolling: false)
                } else {
                    missingImages.insert(key)
                }
            }
        }
        return nil
    }

    private func materializeSteerImages(in message: RemoteMessage, runId: String? = nil, allowedFilenames: Set<String>? = nil) {
        guard message.role == .user else { return }
        let filenames = message.images.compactMap(\.filename)
        var jobs: [(filename: String, imageId: String, pending: (runId: String, data: Data)?)] = []
        for reference in message.images {
            guard let filename = reference.filename,
                  filenames.filter({ $0 == filename }).count == 1,
                  allowedFilenames?.contains(filename) ?? true,
                  !ambiguousSteerFilenames.contains(filename) else { continue }
            jobs.append((filename, reference.imageId, pendingSteerImages[filename]))
        }
        guard !jobs.isEmpty else { return }
        let (desktopId, threadId, messageId) = (desktopId, threadId, message.id)
        SentImages.queue.async { [weak self] in
            let store = SentImages.store
            var saved: [(filename: String, imageId: String, data: Data)] = []
            var failed = false
            for job in jobs {
                guard let pending = job.pending ?? store.loadPending(desktopId: desktopId, threadId: threadId, filename: job.filename),
                      runId == nil || pending.runId == runId else { continue }
                do {
                    try store.save(pending.data, desktopId: desktopId, threadId: threadId, messageId: messageId, imageId: job.imageId)
                    saved.append((job.filename, job.imageId, pending.data))
                    try store.removePending(desktopId: desktopId, threadId: threadId, filename: job.filename)
                } catch {
                    failed = true
                }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for image in saved {
                    let key = imageKey(messageId: messageId, imageId: image.imageId)
                    imageData[key] = image.data
                    missingImages.remove(key)
                    loadingImages.remove(key)
                    pendingSteerImages[image.filename] = nil
                }
                if failed { lastError = String(localized: "Image sent, but its local preview could not be saved.") }
                if !saved.isEmpty { scheduleDeltaRebuild(scrolling: false) }
            }
        }
    }

    // MARK: Actions

    /// Reserves the composer while attachments upload; it never queues an offline send.
    func beginUpload() -> Bool {
        guard !isSending else { return false }
        guard store.link(for: desktopId)?.state == .online else {
            outboundState = .offline
            lastError = String(localized: "Offline — nothing was sent. Your draft is kept.")
            return false
        }
        lastError = nil
        outboundState = .uploading
        return true
    }

    func failUpload(_ error: Error) {
        guard outboundState == .uploading else { return }
        outboundState = .rejected
        lastError = String(localized: "Attachment upload did not complete. Your message was not sent.") + " " + describe(error)
    }

    func send(text: String, attachmentIds: [String], mode: SendMode?, attachments: [ChatInputAttachment] = []) async -> Bool {
        guard outboundState != .sending else { return false }
        guard store.link(for: desktopId)?.state == .online else {
            outboundState = .offline
            lastError = String(localized: "Offline — nothing was sent. Your draft is kept.")
            return false
        }
        outboundState = .sending
        lastError = nil
        do {
            let accepted: RemoteChatAccepted = try await store.call(desktopId, "chat.send", ChatSendInput(
                threadId: threadId,
                content: text,
                attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds,
                mode: mode?.rawValue
            ))
            if accepted.kind == .runStarted { observeRun(accepted.runId) }
            outboundState = accepted.kind == .runStarted ? .accepted : .queued
            if let userMessage = accepted.userMessage {
                let images = attachments.filter { $0.type == .image }
                if images.count == userMessage.images.count {
                    var writes: [(data: Data, imageId: String)] = []
                    for (image, reference) in zip(images, userMessage.images) {
                        let key = imageKey(messageId: userMessage.id, imageId: reference.imageId)
                        if !image.fileData.isEmpty { imageData[key] = image.fileData }
                        missingImages.remove(key)
                        writes.append((image.fileData, reference.imageId))
                    }
                    saveSentImages(writes, messageId: userMessage.id)
                }
                upsertLoaded(userMessage)
            } else if accepted.kind == .activeRunSteerPending {
                savePendingSteerImages(attachments, runId: accepted.runId)
            }
            // Acknowledgement clears the draft immediately; history refresh must not delay it.
            if accepted.kind == .activeRunFollowUp { invalidate() }
            userSentSubject.send()
            rebuild(scrolling: true)
            return true
        } catch {
            if let remote = error as? RemoteCallError {
                outboundState = remote.name == "RemoteOffline" ? .offline : .rejected
                lastError = remote.message
            } else if error as? RemoteRequestError == .messageTooLarge {
                outboundState = .rejected
                lastError = String(localized: "This message is too large. Shorten it before sending again. Nothing was sent; your draft is kept.")
            } else if error is EncodingError {
                outboundState = .rejected
                lastError = String(localized: "This message could not be prepared for sending. Nothing was sent; your draft is kept.")
            } else {
                // Once an RPC starts, losing its acknowledgement does not prove rejection.
                outboundState = .unconfirmed
                lastError = String(localized: "Delivery unconfirmed. Check the conversation before sending again; your draft is kept.") + " " + describe(error)
            }
            return false
        }
    }

    /// Delivery already succeeded; failing to retain a local preview cannot reject it.
    private func saveSentImages(_ writes: [(data: Data, imageId: String)], messageId: String) {
        guard !writes.isEmpty else { return }
        let (desktopId, threadId) = (desktopId, threadId)
        SentImages.queue.async { [weak self] in
            var failed = false
            for write in writes {
                do { try SentImages.store.save(write.data, desktopId: desktopId, threadId: threadId, messageId: messageId, imageId: write.imageId) }
                catch { failed = true }
            }
            guard failed else { return }
            DispatchQueue.main.async { [weak self] in
                self?.lastError = String(localized: "Image sent, but its local preview could not be saved.")
            }
        }
    }

    /// A steer has no message id yet; its composer UUID filename identifies the image until the
    /// user message materializes. A name seen twice is ambiguous and never materializes.
    private func savePendingSteerImages(_ attachments: [ChatInputAttachment], runId: String) {
        var candidates: [(filename: String, data: Data)] = []
        for image in attachments where image.type == .image && !image.fileData.isEmpty {
            let filename = image.storageFilename
            // Only composer-generated UUID names are unambiguous across pending steers.
            guard filename.hasSuffix(".jpeg"),
                  UUID(uuidString: String(filename.dropLast(5))) != nil,
                  !(detail?.messages ?? []).contains(where: { $0.images.contains(where: { $0.filename == filename }) }),
                  !ambiguousSteerFilenames.contains(filename) else { continue }
            if pendingSteerImages[filename] != nil {
                pendingSteerImages[filename] = nil
                ambiguousSteerFilenames.insert(filename)
                let (desktopId, threadId) = (desktopId, threadId)
                SentImages.queue.async { try? SentImages.store.removePending(desktopId: desktopId, threadId: threadId, filename: filename) }
            } else {
                // Recorded now so a completion that arrives before the disk write still finds it.
                pendingSteerImages[filename] = (runId, image.fileData)
                candidates.append((filename, image.fileData))
            }
        }
        guard !candidates.isEmpty else { return }
        let (desktopId, threadId) = (desktopId, threadId)
        SentImages.queue.async { [weak self] in
            let store = SentImages.store
            var ambiguous: [String] = []
            var failed = false
            for candidate in candidates {
                // A pending file from an earlier session with the same name makes it ambiguous.
                if store.loadPending(desktopId: desktopId, threadId: threadId, filename: candidate.filename) != nil {
                    ambiguous.append(candidate.filename)
                    try? store.removePending(desktopId: desktopId, threadId: threadId, filename: candidate.filename)
                    continue
                }
                do { try store.savePending(candidate.data, desktopId: desktopId, threadId: threadId, filename: candidate.filename, runId: runId) }
                catch { failed = true }
            }
            guard failed || !ambiguous.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for filename in ambiguous {
                    pendingSteerImages[filename] = nil
                    ambiguousSteerFilenames.insert(filename)
                }
                if failed { lastError = String(localized: "Image sent, but its local preview could not be saved.") }
            }
        }
    }

    func answer(_ question: QuestionContentPart, with answer: String) async {
        do {
            let _: RemoteOk = try await store.call(desktopId, "run.answerToolQuestion", AnswerInput(
                threadId: threadId, runId: question.runId, toolCallId: question.id, answer: answer
            ))
            if let call = liveToolCalls[question.id] ?? detail?.toolCalls.first(where: { $0.id == question.id }) {
                liveToolCalls[question.id] = call.answered(answer)
            }
            rebuild(scrolling: false)
        } catch {
            lastError = describe(error)
        }
    }

    func stop() async {
        guard let runId = activeRunId, !isStopping else { return }
        isStopping = true
        lastError = nil
        defer { isStopping = false }
        do {
            let _: RemoteOk = try await store.call(desktopId, "run.cancel", RunIdInput(runId: runId))
        } catch {
            lastError = describe(error)
        }
    }

    func removeFollowUp(_ messageId: String) async {
        do {
            let _: RemoteOk = try await store.call(desktopId, "chat.removeFollowUp", MessageRefInput(threadId: threadId, messageId: messageId))
            await reload()
        } catch {
            lastError = describe(error)
        }
    }

    func retry(_ messageId: String) async {
        do {
            let _: RemoteChatRetryOutput = try await store.call(desktopId, "chat.retry", MessageRefInput(threadId: threadId, messageId: messageId))
        } catch {
            lastError = describe(error)
        }
    }

    func edit(_ messageId: String, text: String) async {
        do {
            let _: RemoteChatAccepted = try await store.call(desktopId, "chat.edit", EditInput(threadId: threadId, messageId: messageId, content: text))
            await reload()
        } catch {
            lastError = describe(error)
        }
    }

    func showSibling(of messageId: String, offset: Int) async {
        guard let message = detail?.messages.first(where: { $0.id == messageId }),
              let siblings = message.siblingIds, let index = siblings.firstIndex(of: messageId)
        else { return }
        let target = index + offset
        guard siblings.indices.contains(target) else { return }
        do {
            let _: RemoteOk = try await store.call(desktopId, "branch.select", BranchSelectInput(threadId: threadId, assistantMessageId: siblings[target]))
            await reload()
        } catch {
            lastError = describe(error)
        }
    }

    func branch(from messageId: String) async -> RemoteThreadSummary? {
        do {
            let output: RemoteBranchCreateOutput = try await store.call(desktopId, "branch.create", MessageRefInput(threadId: threadId, messageId: messageId))
            store.upsert(desktopId: desktopId, summary: output.thread)
            return output.thread
        } catch {
            lastError = describe(error)
            return nil
        }
    }

    func acceptPlan(handoff: Bool) async -> RemoteChatAccepted? {
        do {
            let accepted: RemoteChatAccepted = try await store.call(desktopId, "plan.accept", PlanAcceptInput(threadId: threadId, mode: handoff ? "handoff" : "direct"))
            UINotificationFeedback.success()
            if !handoff { await reload() }
            return accepted
        } catch {
            lastError = describe(error)
            return nil
        }
    }

    func readPlan(messageId: String) async -> String? {
        // Opening a historical card must read that document, not the current plan.
        if let cached = detail?.messages.first(where: { $0.id == messageId && $0.isPlanDocument }), !cached.content.isEmpty {
            return cached.content
        }
        if detail?.pendingPlan == true, let pendingPlanContent { return pendingPlanContent }
        do {
            let output: RemotePlanReadOutput = try await store.call(desktopId, "plan.read", ThreadRefInput(threadId: threadId))
            return output.content
        } catch {
            lastError = String(localized: "This plan is not available in the local cache.") + " " + describe(error)
            return nil
        }
    }

    func toolCall(_ id: String) -> RemoteToolCall? {
        liveToolCalls[id] ?? detail?.toolCalls.first { $0.id == id }
    }

    /// The preview to show: inline (older desktops) or fetched on demand.
    func toolPreview(_ id: String) -> (input: String?, output: String?) {
        let call = toolCall(id)
        let fetched = toolPreviews[id]
        return (call?.inputPreview ?? fetched?.inputPreview, call?.outputPreview ?? fetched?.outputPreview)
    }

    /// True when the desktop holds a preview this phone has not fetched yet.
    func needsToolPreview(_ id: String) -> Bool {
        guard let call = toolCall(id), call.hasPreview == true,
              call.inputPreview == nil, call.outputPreview == nil else { return false }
        return toolPreviews[id] == nil
    }

    /// Fetches the preview with `tools.getPreview`; `refresh` replaces a cached one. Returns an
    /// error description when it could not be loaded.
    func loadToolPreview(_ id: String, refresh: Bool = false) async -> String? {
        guard let call = toolCall(id), call.hasPreview == true, refresh || toolPreviews[id] == nil else { return nil }
        do {
            let preview: RemoteToolsGetPreviewOutput = try await store.call(desktopId, "tools.getPreview", RemoteToolsGetPreviewInput(threadId: threadId, toolCallId: id))
            toolPreviews[id] = preview
            return nil
        } catch {
            return describe(error)
        }
    }

    func setStarred(_ starred: Bool) async {
        do {
            try await store.setStarred(desktopId: desktopId, threadId: threadId, starred: starred)
        } catch {
            lastError = describe(error)
        }
    }

    func archive() async -> Bool {
        do {
            try await store.archive(desktopId: desktopId, threadId: threadId)
            return true
        } catch {
            lastError = describe(error)
            return false
        }
    }

    private func describe(_ error: Error) -> String {
        if let error = error as? RemoteCallError { return error.message }
        return error.localizedDescription
    }
}

// MARK: - Inputs

struct ThreadLoadInput: Encodable { let threadId: String; let limit: Int?; let beforeMessageId: String?; let omitToolPreviews: Bool? }
struct ThreadRefInput: Encodable { let threadId: String }
struct MessageRefInput: Encodable { let threadId: String; let messageId: String }
struct ChatSendInput: Encodable { let threadId: String; let content: String; let attachmentIds: [String]?; let mode: String? }
struct AnswerInput: Encodable { let threadId: String; let runId: String; let toolCallId: String; let answer: String }
struct RunIdInput: Encodable { let runId: String }
struct EditInput: Encodable { let threadId: String; let messageId: String; let content: String }
struct BranchSelectInput: Encodable { let threadId: String; let assistantMessageId: String }
struct PlanAcceptInput: Encodable { let threadId: String; let mode: String }
struct StarInput: Encodable { let threadId: String; let starred: Bool }

extension RemoteThreadDetail {
    func replacing(messages: [RemoteMessage]) -> RemoteThreadDetail {
        RemoteThreadDetail(
            activeRunId: activeRunId, activeRunMode: activeRunMode, hasMoreBefore: hasMoreBefore,
            messages: messages, pendingPlan: pendingPlan, queuedFollowUps: queuedFollowUps,
            streamSnapshotSeq: streamSnapshotSeq,
            thread: thread, todoItems: todoItems, toolCalls: toolCalls
        )
    }
}

extension RemoteToolCall {
    func answered(_ answer: String) -> RemoteToolCall {
        RemoteToolCall(
            assistantMessageId: assistantMessageId, error: error, finishedAt: finishedAt, hasPreview: hasPreview, id: id,
            inputPreview: inputPreview, outputPreview: outputPreview,
            question: question.map { RemoteToolQuestion(answer: answer, choices: $0.choices, question: $0.question) },
            requestMessageId: requestMessageId, runId: runId, startedAt: startedAt, status: .running,
            title: title, toolName: toolName, truncated: truncated
        )
    }
}

enum UINotificationFeedback {
    @MainActor static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}
