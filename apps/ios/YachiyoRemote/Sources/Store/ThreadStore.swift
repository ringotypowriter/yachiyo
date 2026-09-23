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

/// The open thread: its loaded branch, live streaming state, and the actions the phone can
/// take. Implements `ChatMessageSource` so the forked message list renders it directly.
@MainActor
final class ThreadStore: ChatMessageSource {
    let desktopId: String
    let threadId: String
    private let store: RemoteStore

    @Published private(set) var summary: RemoteThreadSummary?
    @Published private(set) var detail: RemoteThreadDetail?
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    @Published private(set) var isStopping = false
    private var needsReload = true
    private var reloadAgain = false
    private var loadToken: UUID?
    private var isOpen = false
    private var eventsDuringLoad: [RemoteEvent] = []
    private var isReplayingLoadEvents = false
    @Published private(set) var lastError: String?

    /// Messages streaming in the active run (message id → accumulated text / reasoning).
    private var streamingText: [String: String] = [:]
    private var streamingReasoning: [String: String] = [:]
    private var streamingParent: [String: String] = [:]
    private var streamingOrder: [String] = []
    private var liveToolCalls: [String: RemoteToolCall] = [:]
    private var runFooters: [String: String] = [:]
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
        needsReload = cached == nil || cached?.needsRefresh == true || activeRunId != nil
        summary = store.summary(desktopId: desktopId, threadId: threadId) ?? cached?.detail.thread
        rebuild(scrolling: false)
        store.threadEvents
            .filter { [desktopId, threadId] in $0.desktopId == desktopId && $0.event.threadId == threadId }
            .sink { [weak self] in self?.apply($0.event) }
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
                    if loadToken != nil { needsReload = true }
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
        isOpen = true
        store.setOpenThread(desktopId: desktopId, threadId: threadId)
        await reloadIfNeeded()
    }

    func close() {
        isOpen = false
        needsReload = true
        loadToken = nil
        isLoading = false
        eventsDuringLoad.removeAll()
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
        guard await link.waitForWatch(threadId: threadId), isOpen else { return }
        guard loadToken == nil, force || needsReload || detail == nil else { return }
        needsReload = true
        store.dirtyThread(desktopId: desktopId, threadId: threadId)
        reloadAgain = false
        let token = UUID()
        loadToken = token
        eventsDuringLoad.removeAll()
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
            try Task.checkCancellation()
            guard loadToken == token, isOpen else { return }
            detail = loaded
            summary = loaded.thread
            store.upsert(desktopId: desktopId, summary: loaded.thread)
            activeRunId = loaded.activeRunId
            streamingText.removeAll()
            streamingReasoning.removeAll()
            streamingParent.removeAll()
            streamingOrder.removeAll()
            liveToolCalls.removeAll()
            lastError = nil
            let buffered = eventsDuringLoad
            needsReload = reloadAgain
            store.cacheThread(desktopId: desktopId, detail: loaded, needsRefresh: !buffered.isEmpty || reloadAgain)
            completed = true
            loadToken = nil
            isLoading = false
            eventsDuringLoad.removeAll()
            isReplayingLoadEvents = true
            for event in buffered { apply(event) }
            isReplayingLoadEvents = false
            rebuild(scrolling: initialLoad)
        } catch {
            guard loadToken == token, !Task.isCancelled, !(error is CancellationError) else { return }
            loadError = describe(error)
        }
    }

    // MARK: Events

    private func apply(_ event: RemoteEvent) {
        guard isOpen else { return }
        if loadToken != nil { eventsDuringLoad.append(event) }
        switch event.type {
        case .messageStarted:
            guard let messageId = event.messageId else { return }
            activeRunId = event.runId ?? activeRunId
            if streamingText[messageId] == nil {
                streamingText[messageId] = ""
                streamingOrder.append(messageId)
            }
            if let parent = event.parentMessageId { streamingParent[messageId] = parent }
            rebuild(scrolling: true)
        case .messageDelta:
            guard let messageId = event.messageId else { return }
            if streamingText[messageId] == nil { streamingOrder.append(messageId) }
            streamingText[messageId, default: ""] += event.delta ?? ""
            rebuild(scrolling: true)
        case .messageReasoningDelta:
            guard let messageId = event.messageId else { return }
            if streamingText[messageId] == nil {
                streamingText[messageId] = ""
                streamingOrder.append(messageId)
            }
            streamingReasoning[messageId, default: ""] += event.delta ?? ""
            rebuild(scrolling: true)
        case .messageCompleted:
            guard let message = event.message else { return }
            upsertLoaded(message)
            streamingText[message.id] = nil
            streamingReasoning[message.id] = nil
            streamingOrder.removeAll { $0 == message.id }
            rebuild(scrolling: true)
        case .toolUpdated:
            guard let toolCall = event.toolCall else { return }
            liveToolCalls[toolCall.id] = toolCall
            rebuild(scrolling: true)
        case .runStatus:
            guard let runId = event.runId, let status = event.status else { return }
            if status == .running {
                activeRunId = runId
            } else {
                if activeRunId == runId { activeRunId = nil }
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
            loadToken = nil
            reloadAgain = false
            needsReload = false
            isLoading = false
            eventsDuringLoad.removeAll()
            detail = nil
            summary = nil
            activeRunId = nil
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
    }

    // MARK: Timeline

    private func rebuild(scrolling: Bool) {
        guard !isReplayingLoadEvents else { return }
        let toolCalls = allToolCalls
        let loaded = detail?.messages ?? []
        var built: [ConversationMessage] = []
        let lastPlanId = loaded.last(where: \.isPlanDocument)?.id

        for message in loaded {
            built.append(conversationMessage(
                id: message.id,
                role: message.role == .user ? .user : .assistant,
                text: message.content,
                reasoning: message.reasoning,
                reasoningCollapsed: true,
                createdAt: message.createdAt.isoDate ?? Date(),
                attachments: message.attachments.map(\.filename) + message.images.map { $0.filename ?? "image" },
                toolCalls: toolCalls.filter { $0.assistantMessageId == message.id },
                siblings: message.siblingIds,
                plan: message.isPlanDocument ? ((detail?.pendingPlan ?? false) && message.id == lastPlanId ? "pending" : "accepted") : nil
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
        plan: String?
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
        var metadata: [String: String] = [:]
        if let siblings, siblings.count > 1, let index = siblings.firstIndex(of: id) {
            metadata[MessageMetadataKey.siblingIndex] = String(index)
            metadata[MessageMetadataKey.siblingCount] = String(siblings.count)
        }
        if let plan { metadata[MessageMetadataKey.plan] = plan }
        return ConversationMessage(id: id, conversationID: threadId, role: role, parts: parts, createdAt: createdAt, metadata: metadata)
    }

    // MARK: Actions

    func send(text: String, attachmentIds: [String], mode: SendMode?) async -> Bool {
        do {
            let accepted: RemoteChatAccepted = try await store.call(desktopId, "chat.send", ChatSendInput(
                threadId: threadId,
                content: text,
                attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds,
                mode: mode?.rawValue
            ))
            if accepted.kind == .runStarted { activeRunId = accepted.runId }
            if let userMessage = accepted.userMessage {
                upsertLoaded(userMessage)
            }
            if accepted.kind == .activeRunFollowUp { await reload() }
            userSentSubject.send()
            rebuild(scrolling: true)
            lastError = nil
            return true
        } catch {
            lastError = describe(error)
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

    func readPlan() async -> String? {
        let output: RemotePlanReadOutput? = try? await store.call(desktopId, "plan.read", ThreadRefInput(threadId: threadId))
        return output?.content
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

