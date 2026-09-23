import Combine
import OSLog
import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// One thread in the unified inbox, tagged with the desktop that owns it.
struct InboxItem: Hashable, Identifiable {
    let desktopId: String
    var summary: RemoteThreadSummary

    var id: String { "\(desktopId)/\(summary.id)" }

    static func == (lhs: InboxItem, rhs: InboxItem) -> Bool {
        lhs.id == rhs.id && lhs.summary == rhs.summary
    }

    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct DesktopSnapshot: Equatable {
    let id: String
    let name: String
    let state: DesktopConnectionState
    let isPrimary: Bool
    var endpoints: [StoredEndpoint] = []
    var attemptingURL: String? = nil
    var activeURL: String? = nil
    var lastSuccessfulURL: String? = nil
    var lastConnectionError: String? = nil
    var recovery: AddressRecoveryStatus? = nil
    var lastAddressUpdateAt: Date? = nil
    var lastAddressUpdateURL: String? = nil
}

/// App-wide remote state: paired desktops, their connections, and the merged inbox. Thread
/// pages subscribe to `threadEvents` for their thread and ask for thread-scope events.
@MainActor
final class RemoteStore {
    static let shared = RemoteStore(credentials: KeychainCredentialStore())
    private static let logger = Logger(subsystem: "sh.ringo.yachiyo.remote", category: "Inbox")

    private let cacheStore: RemoteCacheStore
    private let cacheQueue = DispatchQueue(label: "sh.ringo.yachiyo.remote.cache", qos: .utility)
    private var caches: [String: RemoteDesktopCache] = [:]
    private var cacheSaveTask: Task<Void, Never>?
    private var isWritingCache = false
    private var hasPendingCacheWrite = false
    private var cacheWriteToken = UUID()
    private var inboxInvalidations: Set<String> = []
    private var inboxEvents: [String: [RemoteEvent]] = [:]
    private var recentThreads: [String: [String]] = [:]
    private let credentials: RemoteCredentialStore
    private var links: [String: DesktopLink] = [:]
    private var summaries: [String: [String: RemoteThreadSummary]] = [:]

    @Published private(set) var desktops: [DesktopSnapshot] = []
    @Published private(set) var inbox: [InboxItem] = []
    @Published private(set) var inboxLoadErrors: [String: String] = [:]
    @Published private(set) var appearance: RemoteAppearance?
    /// Unread completions (run finished while the thread was not open).
    @Published private(set) var unreadCompletions: Set<String> = []
    let threadEvents = PassthroughSubject<(desktopId: String, event: RemoteEvent), Never>()
    let resyncs = PassthroughSubject<String, Never>()

    private var inboxLoadTokens: [String: UUID] = [:]
    @Published private(set) var loadingInboxes: Set<String> = []
    private var connectedDesktops: Set<String> = []

    private var openThread: (desktopId: String, threadId: String)?
    private lazy var connector = DesktopConnector(identity: identity(), mailbox: MailboxFolder.source())

    init(credentials: RemoteCredentialStore, cacheStore: RemoteCacheStore? = nil) {
        self.credentials = credentials
        self.cacheStore = cacheStore ?? RemoteCacheStore(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteSnapshots", isDirectory: true))
    }

    func cachedThread(desktopId: String, threadId: String) -> RemoteCachedThread? {
        touchThread(desktopId: desktopId, threadId: threadId)
        return caches[desktopId]?.threads[threadId]
    }

    func cacheThread(desktopId: String, detail: RemoteThreadDetail, needsRefresh: Bool) {
        guard caches[desktopId] != nil else { return }
        touchThread(desktopId: desktopId, threadId: detail.thread.id)
        caches[desktopId]?.threads[detail.thread.id] = RemoteCachedThread(detail: detail, needsRefresh: needsRefresh || detail.activeRunId != nil)
        let keep = Set((recentThreads[desktopId] ?? []).prefix(20))
        let retained = caches[desktopId]!.threads.filter { keep.contains($0.key) }
        caches[desktopId]?.threads = retained
        checkpoint(desktopId)
    }

    func dirtyThread(desktopId: String, threadId: String) {
        caches[desktopId]?.threads[threadId]?.needsRefresh = true
        checkpoint(desktopId)
    }

    private func touchThread(desktopId: String, threadId: String) {
        if recentThreads[desktopId] == nil { recentThreads[desktopId] = caches[desktopId].map { Array($0.threads.keys) } ?? [] }
        recentThreads[desktopId]?.removeAll { $0 == threadId }
        recentThreads[desktopId, default: []].insert(threadId, at: 0)
        recentThreads[desktopId] = Array((recentThreads[desktopId] ?? []).prefix(20))
    }

    /// Cursor and applied state are copied together on the main actor, then written serially.
    private func checkpoint(_ desktopId: String) {
        caches[desktopId]?.cursor = links[desktopId]?.cursor
        if let values = summaries[desktopId] { caches[desktopId]?.summaries = Array(values.values) }
        if isWritingCache {
            hasPendingCacheWrite = true
            return
        }
        guard cacheSaveTask == nil else { return }
        cacheSaveTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard let self else { return }
            cacheSaveTask = nil
            flushCaches(synchronously: false)
        }
    }

    private func flushCaches(synchronously: Bool) {
        cacheSaveTask?.cancel()
        cacheSaveTask = nil
        if !synchronously, isWritingCache {
            hasPendingCacheWrite = true
            return
        }
        let snapshots = caches
        let disk = cacheStore
        let logger = Self.logger
        let save: @Sendable () -> Void = {
            for (id, cache) in snapshots {
                do { try disk.save(cache, desktopId: id) }
                catch { logger.error("Remote snapshot save failed") }
            }
        }
        if synchronously {
            // Drain any older write before the newest snapshot. Its queued completion must
            // not clear the state of a subsequent foreground write.
            cacheQueue.sync(execute: save)
            cacheWriteToken = UUID()
            isWritingCache = false
            hasPendingCacheWrite = false
        } else {
            isWritingCache = true
            hasPendingCacheWrite = false
            let token = UUID()
            cacheWriteToken = token
            // Enqueue immediately so suspend/remove remain ordered on this serial queue.
            // While busy, checkpoints retain only a flag, not additional full snapshots.
            cacheQueue.async { [weak self] in
                save()
                Task { @MainActor [weak self] in
                    guard let self, cacheWriteToken == token else { return }
                    isWritingCache = false
                    if hasPendingCacheWrite { flushCaches(synchronously: false) }
                }
            }
        }
    }

    private func discardCache(_ desktopId: String) {
        caches[desktopId] = nil
        summaries[desktopId] = nil
        recentThreads[desktopId] = nil
        let disk = cacheStore
        cacheQueue.sync { try? disk.remove(desktopId: desktopId) }
    }

    private func invalidate(_ link: DesktopLink) {
        guard links[link.id] === link else { return }
        caches[link.id]?.needsInboxRefresh = true
        if let ids = caches[link.id]?.threads.keys {
            for id in ids { caches[link.id]?.threads[id]?.needsRefresh = true }
        }
        if inboxLoadTokens[link.id] != nil { inboxInvalidations.insert(link.id) }
        checkpoint(link.id)
        resyncs.send(link.id)
        if link.state == .online { Task { await self.reloadSummaries(for: link) } }
    }

    var hasDesktops: Bool { !links.isEmpty }

    func link(for desktopId: String) -> DesktopLink? { links[desktopId] }

    var primaryDesktopId: String? {
        let stored = UserDefaults.standard.string(forKey: "primaryDesktopId")
        if let stored, links[stored] != nil { return stored }
        return desktops.first?.id
    }

    func setPrimaryDesktop(_ id: String) {
        UserDefaults.standard.set(id, forKey: "primaryDesktopId")
        publishDesktops()
        refreshAppearance()
    }

    // MARK: Lifecycle

    func bootstrap() {
        let stored = (try? credentials.loadDesktops()) ?? []
        for desktop in stored where links[desktop.remoteDeviceId] == nil {
            links[desktop.remoteDeviceId] = makeLink(desktop)
        }
        publishDesktops()
        publishInbox()
        resume()
    }

    func resume() {
        for link in links.values { link.start() }
    }

    func suspend() {
        inboxLoadTokens.removeAll()
        inboxEvents.removeAll()
        loadingInboxes.removeAll()
        for link in links.values { link.stop() }
        flushCaches(synchronously: true)
    }

    // MARK: Pairing

    @discardableResult
    func pair(url: URL) async throws -> DesktopSnapshot {
        let payload = try PairingURL.decode(url)
        let (client, desktop, hello) = try await connector.pair(payload)
        try credentials.save(desktop)
        links[desktop.remoteDeviceId]?.stop()
        inboxLoadTokens[desktop.remoteDeviceId] = nil
        discardCache(desktop.remoteDeviceId)
        let link = makeLink(desktop, client: client, hello: hello)
        links[desktop.remoteDeviceId] = link
        link.start()
        publishDesktops()
        publishInbox()
        return desktops.first { $0.id == desktop.remoteDeviceId }!
    }

    func remove(desktopId: String) {
        links[desktopId]?.stop()
        inboxLoadTokens[desktopId] = nil
        loadingInboxes.remove(desktopId)
        connectedDesktops.remove(desktopId)
        links[desktopId] = nil
        discardCache(desktopId)
        inboxLoadErrors[desktopId] = nil
        try? credentials.remove(remoteDeviceId: desktopId)
        publishDesktops()
        publishInbox()
    }

    // MARK: Calls

    func call<Output: Decodable>(_ desktopId: String, _ method: String, _ input: some Encodable) async throws -> Output {
        guard let link = links[desktopId] else { throw RemoteCallError(name: "RemoteOffline", message: "Unknown device.") }
        return try await link.call(method, input)
    }

    func updateAddress(desktopId: String, address: String) throws {
        guard let link = links[desktopId] else { throw RemoteCallError(name: "RemoteOffline", message: "Unknown device.") }
        var updated = try DesktopAddress.replacingPrimary(in: link.desktop, address: address)
        guard updated.endpoints != link.desktop.endpoints else { return }
        updated.cursor = link.cursor
        // A failed Keychain write must not switch the live connection to an unsaved target.
        try credentials.save(updated)
        link.replaceDesktop(updated)
    }

    func checkAddressRecovery(desktopId: String) async {
        await links[desktopId]?.checkAddressRecovery()
    }

    func retryConnection(desktopId: String) {
        guard let link = links[desktopId], link.state != .protocolMismatch else { return }
        link.stop()
        link.start()
    }

    func connectionText(for desktop: DesktopSnapshot) -> String? {
        switch desktop.state {
        case .connecting: return connectedDesktops.contains(desktop.id) ? String(localized: "Reconnecting to \(desktop.name)…") : String(localized: "Connecting to \(desktop.name)…")
        case .offline: return String(localized: "\(desktop.name) is offline")
        case .protocolMismatch: return String(localized: "Update Yachiyo on this iPhone or on \(desktop.name) to connect.")
        case .online: return nil
        }
    }

    func refreshInbox() async {
        for link in links.values where link.state != .online && link.state != .protocolMismatch {
            retryConnection(desktopId: link.id)
        }
        for link in links.values where link.state == .online {
            caches[link.id]?.needsInboxRefresh = true
            if inboxLoadTokens[link.id] != nil { inboxInvalidations.insert(link.id) }
            await reloadSummaries(for: link)
        }
    }

    /// Declares the thread on screen so its desktop streams thread-scope events.
    func setOpenThread(desktopId: String?, threadId: String?) {
        if let previous = openThread, previous.desktopId != desktopId || previous.threadId != threadId {
            dirtyThread(desktopId: previous.desktopId, threadId: previous.threadId)
            if previous.desktopId != desktopId { links[previous.desktopId]?.watch(threadIds: []) }
        }
        if let desktopId, let threadId {
            openThread = (desktopId, threadId)
            links[desktopId]?.watch(threadIds: [threadId])
            unreadCompletions.remove("\(desktopId)/\(threadId)")
        } else {
            openThread = nil
        }
    }

    func clearOpenThread(desktopId: String, threadId: String) {
        guard openThread?.desktopId == desktopId, openThread?.threadId == threadId else { return }
        dirtyThread(desktopId: desktopId, threadId: threadId)
        links[desktopId]?.watch(threadIds: [])
        openThread = nil
    }

    func summary(desktopId: String, threadId: String) -> RemoteThreadSummary? {
        summaries[desktopId]?[threadId]
    }

    func upsert(desktopId: String, summary: RemoteThreadSummary) {
        summaries[desktopId, default: [:]][summary.id] = summary
        publishInbox()
        checkpoint(desktopId)
    }

    // MARK: Private

    private func identity() -> RemoteClientIdentity {
        RemoteClientIdentity(
            staticPrivateKey: (try? credentials.phoneStaticKey()) ?? NoiseKeyPair.generatePrivateKey(),
            deviceName: UIDevice.current.name,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        )
    }

    private func makeLink(_ desktop: PairedDesktop, client: RemoteClient? = nil, hello: RemoteHelloOutput? = nil) -> DesktopLink {
        let id = desktop.remoteDeviceId
        let disk = cacheStore
        let cache = cacheQueue.sync { disk.load(desktopId: id, pairingId: desktop.pairingId) } ?? RemoteDesktopCache(pairingId: desktop.pairingId)
        caches[id] = cache
        // The initial global subscription cannot replay events from inactive thread scopes.
        for threadId in cache.threads.keys { caches[id]?.threads[threadId]?.needsRefresh = true }
        if let loaded = cache.summaries { summaries[id] = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new }) }
        return DesktopLink(
            desktop: desktop,
            connector: connector,
            client: client,
            hello: hello,
            cachedCursor: cache.summaries == nil ? nil : cache.cursor,
            onChange: { [weak self] link in self?.linkDidChange(link) },
            onEvent: { [weak self] link, event in self?.handle(event, from: link) },
            onResync: { [weak self] link in
                guard let self else { return }
                self.invalidate(link)
            },
            persist: { [weak self] desktop in try? self?.credentials.save(desktop) }
        )
    }

    private func linkDidChange(_ link: DesktopLink) {
        guard links[link.id] === link else { return }
        let stateChanged = desktops.first { $0.id == link.id }?.state != link.state
        publishDesktops()
        guard stateChanged else { return }
        if link.state == .online { connectedDesktops.insert(link.id) }
        else {
            inboxLoadTokens[link.id] = nil
            inboxEvents[link.id] = nil
            loadingInboxes.remove(link.id)
        }
        if link.state == .online {
            checkpoint(link.id)
            Task { await reloadSummaries(for: link) }
            if link.id == primaryDesktopId { refreshAppearance() }
        } else {
            publishInbox()
        }
    }

    private func reloadSummaries(for link: DesktopLink) async {
        guard links[link.id] === link, link.state == .online,
              caches[link.id]?.summaries == nil || caches[link.id]?.needsInboxRefresh == true,
              inboxLoadTokens[link.id] == nil else { return }
        inboxInvalidations.remove(link.id)
        inboxEvents[link.id] = []
        let token = UUID()
        inboxLoadTokens[link.id] = token
        loadingInboxes.insert(link.id)
        inboxLoadErrors[link.id] = nil
        defer {
            if inboxLoadTokens[link.id] == token {
                inboxLoadTokens[link.id] = nil
                loadingInboxes.remove(link.id)
                inboxEvents[link.id] = nil
                if inboxInvalidations.remove(link.id) != nil {
                    Task { await self.reloadSummaries(for: link) }
                }
            }
        }
        do {
            var collected: [RemoteThreadSummary] = []
            var cursor: String?
            repeat {
                let page: RemoteThreadsListOutput = try await link.call("threads.list", ThreadsListInput(cursor: cursor, limit: 200))
                try Task.checkCancellation()
                guard inboxLoadTokens[link.id] == token else { return }
                collected += page.threads
                cursor = page.nextCursor
            } while cursor != nil
            summaries[link.id] = Dictionary(collected.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            // Pushes can interleave every page. Reapply them after replacing the snapshot.
            for event in inboxEvents[link.id] ?? [] { applyInboxEvent(event, from: link) }
            caches[link.id]?.needsInboxRefresh = inboxInvalidations.contains(link.id)
            checkpoint(link.id)
            inboxLoadErrors[link.id] = nil
            publishInbox()
        } catch {
            guard inboxLoadTokens[link.id] == token, !Task.isCancelled, !(error is CancellationError) else { return }
            let decodingDescription = inboxDecodingErrorDescription(error)
            let underlying = error as NSError
            // Log structural diagnostics only: decoder debugDescription and RPC messages
            // can contain response values, so neither belongs in the system log.
            Self.logger.error("threads.list failed: domain=\(underlying.domain, privacy: .public) code=\(underlying.code) decoding=\(decodingDescription ?? "none", privacy: .public)")
            inboxLoadErrors[link.id] = inboxLoadErrorDescription(error)
            // Do not replace a previously loaded inbox with a partial page or an empty list.
            publishInbox()
        }
    }

    private func refreshAppearance() {
        guard let primary = primaryDesktopId, let link = links[primary], link.state == .online else { return }
        Task {
            if let appearance: RemoteAppearance = try? await link.call("appearance.get", EmptyInput()) {
                self.appearance = appearance
                ThemeController.shared.desktopAppearanceDidChange(appearance)
            }
        }
    }

    private func handle(_ event: RemoteEvent, from link: DesktopLink) {
        guard links[link.id] === link else { return }
        if inboxLoadTokens[link.id] != nil,
           event.type == .threadSummary || event.type == .threadRemoved || event.type == .runStatus {
            inboxEvents[link.id, default: []].append(event)
        }
        // Persist invalidation BEFORE checkpointing the cursor. Inactive scopes miss messages.
        if let id = event.threadId {
            caches[link.id]?.threads[id]?.needsRefresh = true
            if event.type == .threadRemoved { caches[link.id]?.threads[id] = nil }
        } else if event.type == .threadInvalidated {
            invalidate(link)
        }
        applyInboxEvent(event, from: link)
        if let threadId = event.threadId, openThread?.desktopId == link.id, openThread?.threadId == threadId {
            threadEvents.send((link.id, event))
        }
        checkpoint(link.id)
    }

    private func applyInboxEvent(_ event: RemoteEvent, from link: DesktopLink) {
        switch event.type {
        case .threadSummary:
            if let summary = event.summary { upsert(desktopId: link.id, summary: summary) }
        case .threadRemoved:
            if let threadId = event.threadId {
                summaries[link.id]?[threadId] = nil
                publishInbox()
            }
        case .runStatus:
            if let threadId = event.threadId, let runId = event.runId, let status = event.status,
               var summary = summaries[link.id]?[threadId] {
                let startedAt = summary.latestRun?.runId == runId ? summary.latestRun!.startedAt : ISO8601DateFormatter().string(from: Date())
                summary = summary.with(latestRun: LatestRun(runId: runId, startedAt: startedAt, status: status))
                summaries[link.id]?[threadId] = summary
                let key = "\(link.id)/\(threadId)"
                if status == .completed, openThread?.threadId != threadId { unreadCompletions.insert(key) }
                publishInbox()
            }
        case .appearanceChanged:
            if link.id == primaryDesktopId, let appearance = event.appearance {
                self.appearance = appearance
                ThemeController.shared.desktopAppearanceDidChange(appearance)
            }
        default:
            break
        }
    }

    private func publishDesktops() {
        let primary = UserDefaults.standard.string(forKey: "primaryDesktopId")
        let sorted = links.values.sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        let firstId = sorted.first?.id
        desktops = sorted.map {
            DesktopSnapshot(id: $0.id, name: $0.displayName, state: $0.state, isPrimary: $0.id == (primary.flatMap { links[$0] != nil ? $0 : nil } ?? firstId),
                endpoints: $0.desktop.endpoints, attemptingURL: $0.attemptingURL,
                activeURL: $0.activeURL, lastSuccessfulURL: $0.desktop.lastSuccessfulURL,
                lastConnectionError: $0.lastConnectionError, recovery: $0.recovery,
                lastAddressUpdateAt: $0.desktop.lastAddressUpdateAt,
                lastAddressUpdateURL: $0.desktop.lastAddressUpdateURL)
        }
    }

    private func publishInbox() {
        var seenSynced: [String: InboxItem] = [:]
        var items: [InboxItem] = []
        for (desktopId, byId) in summaries {
            for summary in byId.values {
                let item = InboxItem(desktopId: desktopId, summary: summary)
                // A thread synced to several Macs shows once; the native copy (no origin) wins.
                if summary.syncOriginDeviceId == nil {
                    items.append(item)
                } else if seenSynced[summary.id] == nil {
                    seenSynced[summary.id] = item
                }
            }
        }
        let nativeIds = Set(items.map(\.summary.id))
        items += seenSynced.values.filter { !nativeIds.contains($0.summary.id) }
        inbox = items.sorted { $0.summary.updatedAt > $1.summary.updatedAt }
    }
}

struct ThreadsListInput: Encodable {
    let cursor: String?
    let limit: Int
}

struct EmptyInput: Encodable {}

func inboxLoadErrorDescription(_ error: Error) -> String {
    if let description = inboxDecodingErrorDescription(error) { return description }
    if let error = error as? RemoteCallError { return "\(error.name): \(error.message)" }
    switch error {
    case let WebSocketChannelError.closed(code):
        return String(localized: "Connection closed (code \(String(code))).")
    case WebSocketChannelError.unexpectedTextFrame:
        return String(localized: "The connection received an unexpected text response.")
    default:
        return error.localizedDescription
    }
}

/// Unlike localizedDescription, decoding diagnostics identify the failing response field.
/// Never include debugDescription: custom decoders may put user data in it.
func inboxDecodingErrorDescription(_ error: Error) -> String? {
    func path(_ keys: [CodingKey]) -> String {
        keys.reduce("response") { result, key in
            if let index = key.intValue { return "\(result)[\(index)]" }
            return "\(result).\(key.stringValue)"
        }
    }
    switch error {
    case let DecodingError.keyNotFound(key, context):
        return String(localized: "Missing field at \(path(context.codingPath + [key])).")
    case let DecodingError.valueNotFound(_, context):
        return String(localized: "Missing value at \(path(context.codingPath)).")
    case let DecodingError.typeMismatch(_, context):
        return String(localized: "Unexpected value type at \(path(context.codingPath)).")
    case let DecodingError.dataCorrupted(context):
        return String(localized: "Invalid response data at \(path(context.codingPath)).")
    default:
        return nil
    }
}
