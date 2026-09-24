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
    let desktopId: String
    let threadId: String
    private let store: RemoteStore
    private let sentImages = RemoteSentImageStore(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteSentImages", isDirectory: true))
    // Include misses: remote-only images must not trigger disk reads on every streaming delta.
    private var imageData: [String: Data] = [:]
    private var missingImages: Set<String> = []
    private var pendingSteerImages: [String: (runId: String, data: Data)] = [:]
    private var ambiguousSteerFilenames: Set<String> = []

    @Published private(set) var summary: RemoteThreadSummary?
    @Published private(set) var detail: RemoteThreadDetail?
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    @Published private(set) var isStopping = false
    private var needsReload = true
    private var reloadAgain = false
    private var loadToken: UUID?
    private var isOpen = false
    private var eventsDuringLoad: [(event: RemoteEvent, seq: Int)] = []
    private var loadEventsOverflowed = false
    private var isReplayingLoadEvents = false
    private var deltaRebuildTask: Task<Void, Never>?
    @Published private(set) var lastError: String?
    @Published private(set) var outboundState: ThreadOutboundState = .idle
    @Published private(set) var replyState: ThreadReplyState = .idle
    private var respondingRunIds: Set<String> = []
    private var finishedRunIds: Set<String> = []
    var isSending: Bool { outboundState == .uploading || outboundState == .sending }

    /// Messages streaming in the active run (message id → accumulated text / reasoning).
    private var streamingText: [String: String] = [:]
    private var streamingReasoning: [String: String] = [:]
    private var streamingParent: [String: String] = [:]
    private var streamingOrder: [String] = []
    private var liveToolCalls: [String: RemoteToolCall] = [:]
    private var runFooters: [String: String] = [:]
    private var pendingPlanContent: String?
    private var planReadToken: UUID?
    private var activeRunId: String?
    private var cancellables: Set<AnyCancellable> = []

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
        let cached = store.cachedThread(desktopId: desktopId, threadId: threadId)
        detail = cached?.detail
        activeRunId = cached?.detail.activeRunId
        replyState = activeRunId == nil ? .idle : .waiting
        needsReload = cached == nil || cached?.needsRefresh == true || activeRunId != nil
        summary = store.summary(desktopId: desktopId, threadId: threadId) ?? cached?.detail.thread
        rebuild(scrolling: false)
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
        store.$inbox
            .map { [desktopId, threadId] in $0.first { $0.desktopId == desktopId && $0.summary.id == threadId }?.summary }
            .removeDuplicates()
            .sink { [weak self] in if let summary = $0 { self?.summary = summary } }
            .store(in: &cancellables)
    }

    var isRunning: Bool { activeRunId != nil }
    var pendingQuestion: RemoteToolCall? {
        allToolCalls.first { $0.status == .waitingForUser && $0.question != nil }
    }
    var queuedFollowUps: [RemoteMessage] { detail?.queuedFollowUps ?? [] }
    var isReadOnly: Bool { summary?.isReadOnly ?? false }

    private var allToolCalls: [RemoteToolCall] {
        var byId = Dictionary((detail?.toolCalls ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        for (id, call) in liveToolCalls { byId[id] = call }
        return byId.values.sorted { $0.startedAt < $1.startedAt }
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
            let loaded: RemoteThreadDetail = try await store.call(desktopId, "threads.load", ThreadLoadInput(threadId: threadId, limit: 50, beforeMessageId: nil))
            guard loadToken == token, isOpen, !loadEventsOverflowed, !Task.isCancelled else { return }
            pendingPlanContent = nil
            detail = loaded
            summary = loaded.thread
            store.upsert(desktopId: desktopId, summary: loaded.thread)
            activeRunId = loaded.activeRunId.flatMap { finishedRunIds.contains($0) ? nil : $0 }
            updateReplyState()
            streamingText.removeAll()
            streamingReasoning.removeAll()
            streamingParent.removeAll()
            streamingOrder.removeAll()
            liveToolCalls.removeAll()
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
                try? sentImages.removePending(desktopId: desktopId, threadId: threadId)
            }
            let visibleImageKeys = Set((detail?.messages ?? []).flatMap { message in
                message.images.map { imageKey(messageId: message.id, imageId: $0.imageId) }
            } + (detail?.queuedFollowUps ?? []).flatMap { message in
                message.images.map { imageKey(messageId: message.id, imageId: $0.imageId) }
            })
            imageData = imageData.filter { visibleImageKeys.contains($0.key) }
            missingImages = missingImages.intersection(visibleImageKeys)
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
        guard let activeRunId else { replyState = .idle; return }
        replyState = respondingRunIds.contains(activeRunId) ? .responding : .waiting
    }

    private func observeRun(_ runId: String?, responding: Bool = false) {
        guard let runId, !finishedRunIds.contains(runId) else { return }
        if activeRunId != runId {
            // A new run must not attach its tools to a previous run's unfinished bubble.
            streamingText.removeAll()
            streamingReasoning.removeAll()
            streamingParent.removeAll()
            streamingOrder.removeAll()
            liveToolCalls.removeAll()
            activeRunId = runId
        }
        if responding { respondingRunIds.insert(runId) }
        updateReplyState()
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
            if streamingText[messageId] == nil {
                streamingText[messageId] = detail?.messages.first { $0.id == messageId }?.content ?? ""
                streamingOrder.append(messageId)
            }
            if let parent = event.parentMessageId { streamingParent[messageId] = parent }
            rebuild(scrolling: true)
        case .messageDelta:
            guard let messageId = event.messageId else { return }
            observeRun(event.runId ?? activeRunId, responding: true)
            if streamingText[messageId] == nil {
                streamingText[messageId] = detail?.messages.first { $0.id == messageId }?.content ?? ""
                streamingOrder.append(messageId)
            }
            streamingText[messageId, default: ""] += event.delta ?? ""
            scheduleDeltaRebuild()
        case .messageReasoningDelta:
            guard let messageId = event.messageId else { return }
            observeRun(event.runId ?? activeRunId, responding: true)
            if streamingText[messageId] == nil {
                streamingText[messageId] = detail?.messages.first { $0.id == messageId }?.content ?? ""
                streamingOrder.append(messageId)
            }
            if streamingReasoning[messageId] == nil {
                streamingReasoning[messageId] = detail?.messages.first { $0.id == messageId }?.reasoning ?? ""
            }
            streamingReasoning[messageId, default: ""] += event.delta ?? ""
            scheduleDeltaRebuild()
        case .messageCompleted:
            guard let message = event.message else { return }
            if message.role == .user { materializeSteerImages(in: message, runId: event.runId) }
            upsertLoaded(message)
            streamingText[message.id] = nil
            streamingReasoning[message.id] = nil
            streamingOrder.removeAll { $0 == message.id }
            rebuild(scrolling: true)
        case .toolUpdated:
            guard let toolCall = event.toolCall else { return }
            observeRun(event.runId ?? toolCall.runId, responding: true)
            liveToolCalls[toolCall.id] = toolCall
            rebuild(scrolling: true)
        case .runStatus:
            guard let runId = event.runId, let status = event.status else { return }
            if status == .running {
                observeRun(runId)
            } else {
                finishedRunIds.insert(runId)
                respondingRunIds.remove(runId)
                if activeRunId == runId { activeRunId = nil }
                updateReplyState()
                switch status {
                case .cancelled: runFooters[runId] = String(localized: "Stopped")
                case .failed: runFooters[runId] = String(localized: "Failed: \(event.error ?? "")")
                default: runFooters[runId] = nil
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
            streamingText.removeAll()
            streamingReasoning.removeAll()
            streamingParent.removeAll()
            streamingOrder.removeAll()
            liveToolCalls.removeAll()
            rebuild(scrolling: false)
        case .todoUpdated:
            rebuild(scrolling: false)
        default:
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
        detail = current.replacing(messages: list)
        if let detail { store.cacheThread(desktopId: desktopId, detail: detail, needsRefresh: true) }
    }

    // MARK: Timeline

    private func scheduleDeltaRebuild() {
        guard deltaRebuildTask == nil, !isReplayingLoadEvents else { return }
        deltaRebuildTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
            guard let self, isOpen else { return }
            deltaRebuildTask = nil
            rebuild(scrolling: true)
        }
    }

    private func rebuild(scrolling: Bool) {
        deltaRebuildTask?.cancel()
        deltaRebuildTask = nil
        guard !isReplayingLoadEvents else { return }
        let toolCalls = allToolCalls
        let loaded = detail?.messages ?? []
        var built: [ConversationMessage] = []

        for message in loaded {
            built.append(conversationMessage(
                id: message.id,
                role: message.role == .user ? .user : .assistant,
                text: streamingText[message.id] ?? message.content,
                reasoning: streamingReasoning[message.id] ?? message.reasoning,
                reasoningCollapsed: true,
                createdAt: message.createdAt.isoDate ?? Date(),
                attachments: message.attachments.map(\.filename),
                toolCalls: toolCalls.filter { $0.assistantMessageId == message.id },
                siblings: message.siblingIds,
                plan: message.isPlanDocument ? "accepted" : nil,
                images: message.images
            ))
        }

        let loadedIds = Set(loaded.map(\.id))
        let unattached = toolCalls.filter { call in
            call.runId == activeRunId && activeRunId != nil && (call.assistantMessageId == nil || !loadedIds.contains(call.assistantMessageId!))
        }
        for (index, id) in streamingOrder.enumerated() where !loadedIds.contains(id) {
            let isLast = index == streamingOrder.count - 1
            built.append(conversationMessage(
                id: id,
                role: .assistant,
                text: streamingText[id] ?? "",
                reasoning: streamingReasoning[id],
                reasoningCollapsed: !(streamingText[id] ?? "").isEmpty,
                createdAt: Date(),
                attachments: [],
                toolCalls: isLast ? unattached : [],
                siblings: nil,
                plan: nil
            ))
        }
        if streamingOrder.isEmpty, !unattached.isEmpty {
            built.append(conversationMessage(
                id: "run-\(activeRunId ?? "")", role: .assistant, text: "", reasoning: nil, reasoningCollapsed: true,
                createdAt: Date(), attachments: [], toolCalls: unattached, siblings: nil, plan: nil
            ))
        }
        if let last = built.last(where: { $0.role == .assistant }), let footer = runFooters.values.first {
            last.metadata[MessageMetadataKey.footer] = footer
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
        images: [RemoteImageRef] = []
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
        return ConversationMessage(id: id, conversationID: threadId, role: role, parts: parts, createdAt: createdAt, metadata: metadata)
    }

    private func imageKey(messageId: String, imageId: String) -> String {
        "\(messageId.utf8.count):\(messageId)\(imageId)"
    }

    private func retainedImage(messageId: String, imageId: String) -> Data? {
        let key = imageKey(messageId: messageId, imageId: imageId)
        if let data = imageData[key] { return data }
        if missingImages.contains(key) { return nil }
        if let data = sentImages.load(desktopId: desktopId, threadId: threadId, messageId: messageId, imageId: imageId) {
            imageData[key] = data
            return data
        }
        missingImages.insert(key)
        return nil
    }

    private func materializeSteerImages(in message: RemoteMessage, runId: String? = nil, allowedFilenames: Set<String>? = nil) {
        guard message.role == .user else { return }
        let filenames = message.images.compactMap(\.filename)
        for reference in message.images {
            guard let filename = reference.filename,
                  filenames.filter({ $0 == filename }).count == 1,
                  allowedFilenames?.contains(filename) ?? true,
                  !ambiguousSteerFilenames.contains(filename),
                  let pending = pendingSteerImages[filename]
                    ?? sentImages.loadPending(desktopId: desktopId, threadId: threadId, filename: filename),
                  runId == nil || pending.runId == runId else { continue }
            do {
                try sentImages.save(pending.data, desktopId: desktopId, threadId: threadId,
                                    messageId: message.id, imageId: reference.imageId)
                let key = imageKey(messageId: message.id, imageId: reference.imageId)
                imageData[key] = pending.data
                missingImages.remove(key)
                pendingSteerImages[filename] = nil
                try sentImages.removePending(desktopId: desktopId, threadId: threadId, filename: filename)
            } catch {
                lastError = String(localized: "Image sent, but its local preview could not be saved.")
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
                    for (image, reference) in zip(images, userMessage.images) {
                        do {
                            try sentImages.save(image.fileData, desktopId: desktopId, threadId: threadId, messageId: userMessage.id, imageId: reference.imageId)
                            let key = imageKey(messageId: userMessage.id, imageId: reference.imageId)
                            if !image.fileData.isEmpty { imageData[key] = image.fileData }
                            missingImages.remove(key)
                        } catch {
                            // Delivery succeeded; failure to retain a local preview cannot reject it.
                            lastError = String(localized: "Image sent, but its local preview could not be saved.")
                        }
                    }
                }
                upsertLoaded(userMessage)
            } else if accepted.kind == .activeRunSteerPending {
                for image in attachments where image.type == .image && !image.fileData.isEmpty {
                    let filename = image.storageFilename
                    // Only composer-generated UUID names are unambiguous across pending steers.
                    guard filename.hasSuffix(".jpeg"),
                          UUID(uuidString: String(filename.dropLast(5))) != nil,
                          !(detail?.messages ?? []).contains(where: { $0.images.contains(where: { $0.filename == filename }) }),
                          !ambiguousSteerFilenames.contains(filename) else { continue }
                    if pendingSteerImages[filename] != nil || sentImages.loadPending(desktopId: desktopId, threadId: threadId, filename: filename) != nil {
                        pendingSteerImages[filename] = nil
                        ambiguousSteerFilenames.insert(filename)
                        try? sentImages.removePending(desktopId: desktopId, threadId: threadId, filename: filename)
                    } else {
                        do {
                            try sentImages.savePending(image.fileData, desktopId: desktopId, threadId: threadId,
                                                       filename: filename, runId: accepted.runId)
                            pendingSteerImages[filename] = (accepted.runId, image.fileData)
                        } catch {
                            lastError = String(localized: "Image sent, but its local preview could not be saved.")
                        }
                    }
                }
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
        allToolCalls.first { $0.id == id }
    }

    func setStarred(_ starred: Bool) async {
        do {
            let _: RemoteOk = try await store.call(desktopId, "threads.star", StarInput(threadId: threadId, starred: starred))
            if let summary { store.upsert(desktopId: desktopId, summary: summary.with(starred: starred)) }
        } catch {
            lastError = describe(error)
        }
    }

    func archive() async -> Bool {
        do {
            let _: RemoteOk = try await store.call(desktopId, "threads.archive", ThreadRefInput(threadId: threadId))
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

struct ThreadLoadInput: Encodable { let threadId: String; let limit: Int?; let beforeMessageId: String? }
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
            assistantMessageId: assistantMessageId, error: error, finishedAt: finishedAt, id: id,
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
