import Combine
import OSLog
import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// One thread in the unified inbox, tagged with the desktop that owns it. Derived values are
/// computed once per summary change, not on every inbox pass.
struct InboxItem: Hashable, Identifiable {
    let desktopId: String
    let summary: RemoteThreadSummary
    let id: String
    let updatedDate: Date
    /// Case-folded title and preview for local search.
    let searchTitle: String
    let searchPreview: String

    init(desktopId: String, summary: RemoteThreadSummary) {
        self.desktopId = desktopId
        self.summary = summary
        id = "\(desktopId)/\(summary.id)"
        updatedDate = summary.updatedDate
        searchTitle = Self.searchKey(summary.title)
        searchPreview = Self.searchKey(summary.preview ?? "")
    }

    static func searchKey(_ text: String) -> String {
        text.folding(options: .caseInsensitive, locale: .current)
    }

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
    private static let isoFormat = Date.ISO8601FormatStyle()
    private static let maxCachedThreads = 20

    /// In-memory side of one Mac's disk cache and what changed since it was last written.
    private struct DesktopCache {
        let pairingId: String
        var needsInboxRefresh: Bool
        /// Histories on disk, most recently used first (bounded by `maxCachedThreads`).
        var threadIds: [String]
        var staleThreadIds: Set<String>
        /// Histories read from disk or cached during this session.
        var threads: [String: RemoteCachedThread] = [:]
        var dirtyThreads: Set<String> = []
        var removedThreads: Set<String> = []
        var summariesDirty = false
        var stateDirty = false
        var savedCursor: ResumeCursor?

        var hasDirtyData: Bool {
            stateDirty || summariesDirty || !dirtyThreads.isEmpty || !removedThreads.isEmpty
        }
    }

    private let cacheStore: RemoteCacheStore
    private let cacheQueue = DispatchQueue(label: "sh.ringo.yachiyo.remote.cache", qos: .utility)
    /// Keychain writes stay off the main thread; one serial queue keeps them in call order.
    private let credentialQueue = DispatchQueue(label: "sh.ringo.yachiyo.remote.credentials", qos: .utility)
    private var caches: [String: DesktopCache] = [:]
    private var cacheSaveTask: Task<Void, Never>?
    private var cacheSaveDeadline: ContinuousClock.Instant?
    private var isWritingCache = false
    private var hasPendingCacheWrite = false
    private var inboxInvalidations: Set<String> = []
    private var inboxEvents: [String: [RemoteEvent]] = [:]
    private var inboxEventsOverflowed: Set<String> = []
    private let credentials: RemoteCredentialStore
    private var persistedDesktops: [String: PairedDesktop] = [:]
    private var links: [String: DesktopLink] = [:]
    /// Per-Mac inbox; nil means that Mac's inbox has never loaded.
    private var items: [String: [String: InboxItem]] = [:]
    private var inboxPublishTask: Task<Void, Never>?
    private var lastInboxPublish: ContinuousClock.Instant?

    @Published private(set) var desktops: [DesktopSnapshot] = []
    @Published private(set) var inbox: [InboxItem] = []
    @Published private(set) var inboxLoadErrors: [String: String] = [:]
    @Published private(set) var appearance: RemoteAppearance?
    /// Unread completions (run finished while the thread was not open).
    @Published private(set) var unreadCompletions: Set<String> = []
    let threadEvents = PassthroughSubject<(desktopId: String, event: RemoteEvent, seq: Int), Never>()
    let resyncs = PassthroughSubject<String, Never>()
    /// Every changed summary, as soon as it is stored; the published inbox is coalesced.
    let summaryUpdates = PassthroughSubject<(desktopId: String, summary: RemoteThreadSummary), Never>()

    private var inboxLoadTokens: [String: UUID] = [:]
    @Published private(set) var loadingInboxes: Set<String> = []
    private var connectedDesktops: Set<String> = []

    private var openThread: (desktopId: String, threadId: String)?
    /// The static key loads from the Keychain off the main thread, on first use or prefetch.
    private lazy var connector: DesktopConnector = {
        let credentials = credentials
        let identity = RemoteIdentityProvider(
            deviceName: UIDevice.current.name,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            loadStaticKey: { try credentials.phoneStaticKey() }
        )
        return DesktopConnector(identityProvider: identity, mailbox: MailboxFolder.source())
    }()

    init(credentials: RemoteCredentialStore, cacheStore: RemoteCacheStore? = nil) {
        self.credentials = credentials
        self.cacheStore = cacheStore ?? RemoteCacheStore(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteSnapshots", isDirectory: true))
    }

    // MARK: Thread cache

    /// The cached history, read from disk the first time a thread opens in this session.
    func cachedThread(desktopId: String, threadId: String) async -> RemoteCachedThread? {
        touchThread(desktopId: desktopId, threadId: threadId)
        guard let cache = caches[desktopId] else { return nil }
        if let thread = cache.threads[threadId] { return withStaleFlag(thread, desktopId: desktopId) }
        guard cache.threadIds.contains(threadId) else { return nil }
        let pairingId = cache.pairingId
        let disk = cacheStore
        // The serial queue orders this read after every queued write of the same file.
        let loaded = await withCheckedContinuation { continuation in
            cacheQueue.async(qos: .userInitiated) {
                continuation.resume(returning: disk.loadThread(desktopId: desktopId, pairingId: pairingId, threadId: threadId))
            }
        }
        guard caches[desktopId]?.pairingId == pairingId else { return nil }
        if let newer = caches[desktopId]?.threads[threadId] { return withStaleFlag(newer, desktopId: desktopId) }
        guard let loaded, caches[desktopId]?.threadIds.contains(threadId) == true else { return nil }
        caches[desktopId]?.threads[threadId] = loaded
        return withStaleFlag(loaded, desktopId: desktopId)
    }

    func cacheThread(desktopId: String, detail: RemoteThreadDetail, needsRefresh: Bool) {
        guard caches[desktopId] != nil else { return }
        let threadId = detail.thread.id
        let refresh = needsRefresh || detail.activeRunId != nil
        caches[desktopId]?.threads[threadId] = RemoteCachedThread(detail: detail, needsRefresh: refresh)
        caches[desktopId]?.dirtyThreads.insert(threadId)
        caches[desktopId]?.removedThreads.remove(threadId)
        if refresh { caches[desktopId]?.staleThreadIds.insert(threadId) }
        else { caches[desktopId]?.staleThreadIds.remove(threadId) }
        caches[desktopId]?.threadIds.removeAll { $0 == threadId }
        caches[desktopId]?.threadIds.insert(threadId, at: 0)
        caches[desktopId]?.stateDirty = true
        evictThreads(desktopId: desktopId)
        scheduleCacheWrite()
    }

    func dirtyThread(desktopId: String, threadId: String) {
        markThreadStale(desktopId: desktopId, threadId: threadId)
        scheduleCacheWrite()
    }

    private func withStaleFlag(_ thread: RemoteCachedThread, desktopId: String) -> RemoteCachedThread {
        guard !thread.needsRefresh, caches[desktopId]?.staleThreadIds.contains(thread.detail.thread.id) == true else { return thread }
        return RemoteCachedThread(detail: thread.detail, needsRefresh: true)
    }

    /// Only the index changes; the history file is left as written.
    private func markThreadStale(desktopId: String, threadId: String) {
        guard let cache = caches[desktopId], cache.threadIds.contains(threadId),
              !cache.staleThreadIds.contains(threadId) else { return }
        caches[desktopId]?.staleThreadIds.insert(threadId)
        caches[desktopId]?.stateDirty = true
    }

    private func touchThread(desktopId: String, threadId: String) {
        guard let index = caches[desktopId]?.threadIds.firstIndex(of: threadId), index > 0 else { return }
        caches[desktopId]?.threadIds.remove(at: index)
        caches[desktopId]?.threadIds.insert(threadId, at: 0)
        caches[desktopId]?.stateDirty = true
        scheduleCacheWrite()
    }

    private func evictThreads(desktopId: String) {
        guard let ids = caches[desktopId]?.threadIds, ids.count > Self.maxCachedThreads else { return }
        for threadId in ids.dropFirst(Self.maxCachedThreads) { forgetThread(desktopId: desktopId, threadId: threadId) }
    }

    private func forgetThread(desktopId: String, threadId: String) {
        guard caches[desktopId]?.threadIds.contains(threadId) == true else { return }
        caches[desktopId]?.threadIds.removeAll { $0 == threadId }
        caches[desktopId]?.threads[threadId] = nil
        caches[desktopId]?.staleThreadIds.remove(threadId)
        caches[desktopId]?.dirtyThreads.remove(threadId)
        caches[desktopId]?.removedThreads.insert(threadId)
        caches[desktopId]?.stateDirty = true
    }

    // MARK: Cache writes

    /// Changed data is written within a second; a cursor-only change waits longer, since a
    /// lagging cursor only replays a few events. Every write includes all changed data, so the
    /// saved cursor never passes an unsaved change.
    private func scheduleCacheWrite() {
        let hasData = caches.values.contains { $0.hasDirtyData }
        let deadline = ContinuousClock.now + (hasData ? .seconds(1) : .seconds(3))
        if let current = cacheSaveDeadline, current <= deadline { return }
        cacheSaveTask?.cancel()
        cacheSaveDeadline = deadline
        cacheSaveTask = Task { [weak self] in
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            guard let self else { return }
            cacheSaveTask = nil
            cacheSaveDeadline = nil
            flushCaches()
        }
    }

    private struct CacheWrite: Sendable {
        let desktopId: String
        let cache: RemoteDesktopCache
        let summariesChanged: Bool
        let threads: [String: RemoteCachedThread]
        let removedThreads: Set<String>
    }

    /// Cursor and applied state are copied together on the main actor, then written serially.
    private func flushCaches(final: Bool = false, completion: (@MainActor () -> Void)? = nil) {
        cacheSaveTask?.cancel()
        cacheSaveTask = nil
        cacheSaveDeadline = nil
        if !final && isWritingCache {
            hasPendingCacheWrite = true
            return
        }
        if !final {
            isWritingCache = true
            hasPendingCacheWrite = false
        }
        var writes: [CacheWrite] = []
        for (id, cache) in caches {
            let cursor = links[id]?.cursor
            guard cache.hasDirtyData || cursor != cache.savedCursor else { continue }
            let summaries = cache.summariesDirty ? items[id].map { $0.values.map(\.summary) } : nil
            writes.append(CacheWrite(
                desktopId: id,
                cache: RemoteDesktopCache(
                    pairingId: cache.pairingId, cursor: cursor, summaries: summaries,
                    needsInboxRefresh: cache.needsInboxRefresh, threadIds: cache.threadIds,
                    staleThreadIds: cache.staleThreadIds
                ),
                summariesChanged: cache.summariesDirty,
                threads: cache.threads.filter { cache.dirtyThreads.contains($0.key) },
                removedThreads: cache.removedThreads
            ))
            caches[id]?.dirtyThreads = []
            caches[id]?.removedThreads = []
            caches[id]?.summariesDirty = false
            caches[id]?.stateDirty = false
            caches[id]?.savedCursor = cursor
        }
        let disk = cacheStore
        let logger = Self.logger
        // Every write (including a suspend write) is queued immediately, before any later removal.
        // An empty flush still passes through the queue so its completion follows earlier writes.
        cacheQueue.async { [weak self] in
            var failed: [CacheWrite] = []
            for write in writes {
                do {
                    try disk.save(write.cache, desktopId: write.desktopId, summariesChanged: write.summariesChanged,
                                  threads: write.threads, removedThreadIds: write.removedThreads)
                } catch {
                    logger.error("Remote snapshot save failed")
                    failed.append(write)
                }
            }
            DispatchQueue.main.async { [weak self] in
                for write in failed { self?.restoreDirtyState(after: write) }
                if !final, let self {
                    isWritingCache = false
                    if hasPendingCacheWrite { flushCaches() }
                }
                completion?()
            }
        }
    }

    /// A failed save may have left an older history on disk while a later save records a newer
    /// cursor, so everything in it is written again and its histories count as stale meanwhile.
    private func restoreDirtyState(after write: CacheWrite) {
        guard var cache = caches[write.desktopId], cache.pairingId == write.cache.pairingId else { return }
        let threads = Set(write.threads.keys).intersection(cache.threadIds)
        cache.dirtyThreads.formUnion(threads.filter { cache.threads[$0] != nil })
        cache.staleThreadIds.formUnion(threads)
        cache.removedThreads.formUnion(write.removedThreads.subtracting(cache.threadIds))
        if write.summariesChanged { cache.summariesDirty = true }
        cache.stateDirty = true
        cache.savedCursor = nil
        caches[write.desktopId] = cache
    }

    private func discardCache(_ desktopId: String, completion: (@MainActor () -> Void)? = nil) {
        caches[desktopId] = nil
        if items.removeValue(forKey: desktopId) != nil { setNeedsInboxPublish() }
        let disk = cacheStore
        cacheQueue.async {
            try? disk.remove(desktopId: desktopId)
            // Behind any preview write already queued for this Mac.
            SentImages.queue.async {
                try? SentImages.store.remove(desktopId: desktopId)
                if let completion { DispatchQueue.main.async { completion() } }
            }
        }
    }

    /// Full resync: the stream can no longer be trusted, so every cached history and the inbox
    /// must be refetched. A thread-scoped `thread.invalidated` goes through `handle` instead.
    private func invalidate(_ link: DesktopLink) {
        guard links[link.id] === link else { return }
        if var cache = caches[link.id] {
            cache.needsInboxRefresh = true
            cache.staleThreadIds.formUnion(cache.threadIds)
            cache.stateDirty = true
            caches[link.id] = cache
        }
        if inboxLoadTokens[link.id] != nil { inboxInvalidations.insert(link.id) }
        scheduleCacheWrite()
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

    func bootstrap(completion: @escaping @MainActor () -> Void) {
        let credentials = credentials
        let disk = cacheStore
        connector.identityProvider.prefetch()
        // Keychain and cache reads stay off the UI thread. This serial queue puts reads
        // behind any pending suspend saves/removals before a link can use its cursor. Only
        // cursors and inboxes load here; thread histories load when a thread opens.
        cacheQueue.async(qos: .userInitiated) { [weak self] in
            let stored = (try? credentials.loadDesktops()) ?? []
            let loaded = stored.map { desktop -> (RemoteDesktopCache?, [String: InboxItem]?) in
                let cache = disk.load(desktopId: desktop.remoteDeviceId, pairingId: desktop.pairingId)
                let items = cache?.summaries.map { summaries in
                    Dictionary(summaries.map { ($0.id, InboxItem(desktopId: desktop.remoteDeviceId, summary: $0)) },
                               uniquingKeysWith: { _, new in new })
                }
                return (cache, items)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for (desktop, (cache, inboxItems)) in zip(stored, loaded) where links[desktop.remoteDeviceId] == nil {
                    persistedDesktops[desktop.remoteDeviceId] = desktop
                    links[desktop.remoteDeviceId] = makeLink(desktop, cache: cache, items: inboxItems)
                }
                publishDesktops()
                publishInboxNow()
                if UIApplication.shared.applicationState != .background { resume() }
                completion()
            }
        }
    }

    func resume() {
        for link in links.values { link.start() }
    }

    func suspend(completion: @escaping @MainActor () -> Void) {
        inboxLoadTokens.removeAll()
        inboxEvents.removeAll()
        inboxEventsOverflowed.removeAll()
        if !loadingInboxes.isEmpty { loadingInboxes.removeAll() }
        for link in links.values { link.stop() }
        flushCaches(final: true, completion: completion)
    }

    // MARK: Pairing

    @discardableResult
    func pair(url: URL) async throws -> DesktopSnapshot {
        let payload = try PairingURL.decode(url)
        let (client, desktop, hello) = try await connector.pair(payload)
        let id = desktop.remoteDeviceId
        // Detach the previous link first: its disconnect must not overwrite the new record.
        let previous = links.removeValue(forKey: id)
        previous?.stop()
        do {
            try Task.checkCancellation()
            try await saveCredentials(desktop)
        } catch {
            client.close()
            if let previous, links[id] == nil {
                links[id] = previous
                previous.start()
            }
            throw error
        }
        persistedDesktops[id] = desktop
        inboxLoadTokens[id] = nil
        // Finish deleting old sent images before exposing a freshly paired link; otherwise
        // its first send could save a preview into a directory still queued for removal.
        await withCheckedContinuation { continuation in
            discardCache(id) { continuation.resume() }
        }
        do { try Task.checkCancellation() } catch { client.close(); throw error }
        let link = makeLink(desktop, cache: nil, items: nil, client: client, hello: hello)
        links[id] = link
        link.start()
        publishDesktops()
        publishInboxNow()
        return desktops.first { $0.id == id }!
    }

    func remove(desktopId: String) {
        // Detach before stopping so the final disconnect cannot re-save the forgotten record.
        let link = links.removeValue(forKey: desktopId)
        link?.stop()
        inboxLoadTokens[desktopId] = nil
        if loadingInboxes.contains(desktopId) { loadingInboxes.remove(desktopId) }
        connectedDesktops.remove(desktopId)
        discardCache(desktopId)
        if inboxLoadErrors[desktopId] != nil { inboxLoadErrors[desktopId] = nil }
        let prefix = desktopId + "/"
        if unreadCompletions.contains(where: { $0.hasPrefix(prefix) }) {
            unreadCompletions = unreadCompletions.filter { !$0.hasPrefix(prefix) }
        }
        persistedDesktops[desktopId] = nil
        let credentials = credentials
        credentialQueue.async { try? credentials.remove(remoteDeviceId: desktopId) }
        publishDesktops()
        publishInboxNow()
    }

    // MARK: Calls

    func call<Output: Decodable>(_ desktopId: String, _ method: String, _ input: some Encodable) async throws -> Output {
        guard let link = links[desktopId] else { throw RemoteCallError(name: "RemoteOffline", message: "Unknown device.") }
        return try await link.call(method, input)
    }

    func setStarred(desktopId: String, threadId: String, starred: Bool) async throws {
        let _: RemoteOk = try await call(desktopId, "threads.star", StarInput(threadId: threadId, starred: starred))
        if let summary = summary(desktopId: desktopId, threadId: threadId) {
            upsert(desktopId: desktopId, summary: summary.with(starred: starred))
        }
    }

    func archive(desktopId: String, threadId: String) async throws {
        let _: RemoteOk = try await call(desktopId, "threads.archive", ThreadRefInput(threadId: threadId))
    }

    func updateAddress(desktopId: String, address: String) throws {
        guard let link = links[desktopId] else { throw RemoteCallError(name: "RemoteOffline", message: "Unknown device.") }
        let updated = try DesktopAddress.replacingPrimary(in: link.desktop, address: address)
        guard updated.endpoints != link.desktop.endpoints else { return }
        // A failed Keychain write must not switch the live connection to an unsaved target.
        // The write joins the queue so it cannot be reordered with pending link persists.
        let credentials = credentials
        try credentialQueue.sync { try credentials.save(updated) }
        persistedDesktops[desktopId] = updated
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

    func refreshInbox(desktopId: String? = nil) async {
        let targets = links.values.filter { desktopId == nil || $0.id == desktopId }
        for link in targets where link.state != .online && link.state != .protocolMismatch {
            retryConnection(desktopId: link.id)
        }
        await withTaskGroup(of: Void.self) { group in
            for link in targets where link.state == .online {
                if caches[link.id]?.needsInboxRefresh == false {
                    caches[link.id]?.needsInboxRefresh = true
                    caches[link.id]?.stateDirty = true
                }
                if inboxLoadTokens[link.id] != nil { inboxInvalidations.insert(link.id) }
                group.addTask { await self.reloadSummaries(for: link) }
            }
        }
    }

    /// Declares the thread on screen so its desktop streams thread-scope events. Leaving a
    /// thread does not mark its history stale: every later change to it arrives as an inbox
    /// event (summary, run status, removal or invalidation), which marks it in `handle`.
    func setOpenThread(desktopId: String?, threadId: String?) {
        if let previous = openThread, previous.desktopId != desktopId {
            links[previous.desktopId]?.watch(threadIds: [])
        }
        if let desktopId, let threadId {
            openThread = (desktopId, threadId)
            links[desktopId]?.watch(threadIds: [threadId])
            let key = "\(desktopId)/\(threadId)"
            if unreadCompletions.contains(key) { unreadCompletions.remove(key) }
        } else {
            openThread = nil
        }
    }

    func clearOpenThread(desktopId: String, threadId: String) {
        guard openThread?.desktopId == desktopId, openThread?.threadId == threadId else { return }
        links[desktopId]?.watch(threadIds: [])
        openThread = nil
    }

    func summary(desktopId: String, threadId: String) -> RemoteThreadSummary? {
        items[desktopId]?[threadId]?.summary
    }

    func upsert(desktopId: String, summary: RemoteThreadSummary) {
        guard storeSummary(summary, desktopId: desktopId) else { return }
        scheduleCacheWrite()
    }

    // MARK: Private

    private func saveCredentials(_ desktop: PairedDesktop) async throws {
        let credentials = credentials
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            credentialQueue.async {
                do {
                    try credentials.save(desktop)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Links persist on every connect, disconnect and recovery; only changed records are written,
    /// and only for the link that currently owns the pairing.
    private func persist(_ desktop: PairedDesktop) {
        let id = desktop.remoteDeviceId
        guard links[id]?.desktop.pairingId == desktop.pairingId, persistedDesktops[id] != desktop else { return }
        persistedDesktops[id] = desktop
        let credentials = credentials
        credentialQueue.async { try? credentials.save(desktop) }
    }

    private func makeLink(_ desktop: PairedDesktop, cache loadedCache: RemoteDesktopCache?, items loadedItems: [String: InboxItem]?, client: RemoteClient? = nil, hello: RemoteHelloOutput? = nil) -> DesktopLink {
        let id = desktop.remoteDeviceId
        let cache = loadedCache ?? RemoteDesktopCache(pairingId: desktop.pairingId)
        // Cached histories keep their freshness: a resumed stream replays an inbox event for
        // every thread that changed, and a failed resume invalidates them all.
        caches[id] = DesktopCache(
            pairingId: desktop.pairingId, needsInboxRefresh: cache.needsInboxRefresh,
            threadIds: cache.threadIds, staleThreadIds: cache.staleThreadIds, savedCursor: loadedCache?.cursor
        )
        if let loadedItems { items[id] = loadedItems }
        return DesktopLink(
            desktop: desktop,
            connector: connector,
            client: client,
            hello: hello,
            // A cursor is only trusted beside the inbox it describes. The Keychain cursor of an
            // older build is the one-time fallback; DesktopLink strips it on its first write.
            cachedCursor: cache.summaries == nil ? nil : cache.cursor,
            onChange: { [weak self] link in self?.linkDidChange(link) },
            onEvent: { [weak self] link, event, seq in self?.handle(event, seq: seq, from: link) },
            onResync: { [weak self] link in
                guard let self else { return }
                self.invalidate(link)
            },
            persist: { [weak self] desktop in self?.persist(desktop) }
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
            inboxEventsOverflowed.remove(link.id)
            if loadingInboxes.contains(link.id) { loadingInboxes.remove(link.id) }
        }
        if link.state == .online {
            scheduleCacheWrite()
            Task { await reloadSummaries(for: link) }
            if link.id == primaryDesktopId { refreshAppearance() }
        } else {
            setNeedsInboxPublish()
        }
    }

    /// Pages `threads.list` in the background: each page merges into the live inbox as it
    /// arrives, and threads missing from the listing are removed only once every page is in.
    private func reloadSummaries(for link: DesktopLink) async {
        guard links[link.id] === link, link.state == .online,
              items[link.id] == nil || caches[link.id]?.needsInboxRefresh == true,
              inboxLoadTokens[link.id] == nil else { return }
        inboxInvalidations.remove(link.id)
        inboxEvents[link.id] = []
        inboxEventsOverflowed.remove(link.id)
        let token = UUID()
        inboxLoadTokens[link.id] = token
        if !loadingInboxes.contains(link.id) { loadingInboxes.insert(link.id) }
        if inboxLoadErrors[link.id] != nil { inboxLoadErrors[link.id] = nil }
        defer {
            if inboxLoadTokens[link.id] == token {
                inboxLoadTokens[link.id] = nil
                if loadingInboxes.contains(link.id) { loadingInboxes.remove(link.id) }
                inboxEvents[link.id] = nil
                inboxEventsOverflowed.remove(link.id)
                if inboxInvalidations.remove(link.id) != nil {
                    Task { await self.reloadSummaries(for: link) }
                }
            }
        }
        do {
            var listed = Set<String>()
            var cursor: String?
            repeat {
                let page: RemoteThreadsListOutput = try await link.call("threads.list", ThreadsListInput(cursor: cursor, limit: 200))
                try Task.checkCancellation()
                guard inboxLoadTokens[link.id] == token else { return }
                // A bounded event buffer cannot replay every change over this listing. A fresh
                // load is already queued; stop merging pages it would contradict.
                guard !inboxEventsOverflowed.contains(link.id) else { return }
                listed.formUnion(page.threads.map(\.id))
                cursor = page.nextCursor
                mergeListing(page.threads, complete: cursor == nil ? listed : nil, from: link)
            } while cursor != nil
            let refresh = inboxInvalidations.contains(link.id)
            if caches[link.id]?.needsInboxRefresh != refresh {
                caches[link.id]?.needsInboxRefresh = refresh
                caches[link.id]?.stateDirty = true
            }
            scheduleCacheWrite()
            if inboxLoadErrors[link.id] != nil { inboxLoadErrors[link.id] = nil }
        } catch {
            guard inboxLoadTokens[link.id] == token, !Task.isCancelled, !(error is CancellationError) else { return }
            let decodingDescription = inboxDecodingErrorDescription(error)
            let underlying = error as NSError
            // Log structural diagnostics only: decoder debugDescription and RPC messages
            // can contain response values, so neither belongs in the system log.
            Self.logger.error("threads.list failed: domain=\(underlying.domain, privacy: .public) code=\(underlying.code) decoding=\(decodingDescription ?? "none", privacy: .public)")
            inboxLoadErrors[link.id] = inboxLoadErrorDescription(error)
            // Pages already merged stay; nothing is removed from a partial listing.
            setNeedsInboxPublish()
        }
    }

    /// `complete` carries every listed id once the last page arrived.
    private func mergeListing(_ page: [RemoteThreadSummary], complete listed: Set<String>?, from link: DesktopLink) {
        let id = link.id
        if items[id] == nil {
            items[id] = [:]
            caches[id]?.summariesDirty = true
        }
        for summary in page { storeSummary(summary, desktopId: id) }
        if let listed {
            for threadId in items[id]?.keys.filter({ !listed.contains($0) }) ?? [] {
                removeSummary(desktopId: id, threadId: threadId)
            }
        }
        // Pushes can interleave every page. Reapply them over the listing, which may be older.
        for event in inboxEvents[id] ?? [] { applyInboxEvent(event, from: link) }
        setNeedsInboxPublish()
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

    private func handle(_ event: RemoteEvent, seq: Int, from link: DesktopLink) {
        guard links[link.id] === link else { return }
        if inboxLoadTokens[link.id] != nil,
           event.type == .threadSummary || event.type == .threadRemoved || event.type == .runStatus {
            if !inboxEventsOverflowed.contains(link.id) {
                if inboxEvents[link.id, default: []].count < 256 { inboxEvents[link.id, default: []].append(event) }
                else {
                    inboxEvents[link.id] = []
                    inboxEventsOverflowed.insert(link.id)
                    inboxInvalidations.insert(link.id)
                    if caches[link.id]?.needsInboxRefresh == false {
                        caches[link.id]?.needsInboxRefresh = true
                        caches[link.id]?.stateDirty = true
                    }
                }
            }
        }
        // Record staleness in the same snapshot as the cursor that passes this event: inactive
        // scopes miss thread messages, and `thread.invalidated` asks for exactly this thread.
        if let id = event.threadId {
            if event.type == .threadRemoved {
                forgetThread(desktopId: link.id, threadId: id)
                let desktopId = link.id
                SentImages.queue.async { try? SentImages.store.remove(desktopId: desktopId, threadId: id) }
            } else {
                markThreadStale(desktopId: link.id, threadId: id)
            }
        }
        applyInboxEvent(event, from: link)
        if let threadId = event.threadId, openThread?.desktopId == link.id, openThread?.threadId == threadId {
            threadEvents.send((link.id, event, seq))
        }
        scheduleCacheWrite()
    }

    private func applyInboxEvent(_ event: RemoteEvent, from link: DesktopLink) {
        switch event.type {
        case .threadSummary:
            if let summary = event.summary { storeSummary(summary, desktopId: link.id) }
        case .threadRemoved:
            if let threadId = event.threadId { removeSummary(desktopId: link.id, threadId: threadId) }
        case .runStatus:
            if let threadId = event.threadId, let runId = event.runId, let status = event.status,
               let summary = items[link.id]?[threadId]?.summary {
                let startedAt = summary.latestRun?.runId == runId ? summary.latestRun!.startedAt : Self.isoFormat.format(Date())
                storeSummary(summary.with(latestRun: LatestRun(runId: runId, startedAt: startedAt, status: status)), desktopId: link.id)
                let key = "\(link.id)/\(threadId)"
                let isOpen = openThread?.desktopId == link.id && openThread?.threadId == threadId
                if status == .completed, !isOpen, !unreadCompletions.contains(key) { unreadCompletions.insert(key) }
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

    /// Returns false when the summary is unchanged, so replays and reloads publish nothing.
    @discardableResult
    private func storeSummary(_ summary: RemoteThreadSummary, desktopId: String) -> Bool {
        guard items[desktopId]?[summary.id]?.summary != summary else { return false }
        items[desktopId, default: [:]][summary.id] = InboxItem(desktopId: desktopId, summary: summary)
        caches[desktopId]?.summariesDirty = true
        summaryUpdates.send((desktopId, summary))
        setNeedsInboxPublish()
        return true
    }

    private func removeSummary(desktopId: String, threadId: String) {
        guard items[desktopId]?.removeValue(forKey: threadId) != nil else { return }
        caches[desktopId]?.summariesDirty = true
        let key = "\(desktopId)/\(threadId)"
        if unreadCompletions.contains(key) { unreadCompletions.remove(key) }
        setNeedsInboxPublish()
    }

    private func publishDesktops() {
        let primary = UserDefaults.standard.string(forKey: "primaryDesktopId")
        let sorted = links.values.sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        let firstId = sorted.first?.id
        let snapshots = sorted.map {
            DesktopSnapshot(id: $0.id, name: $0.displayName, state: $0.state, isPrimary: $0.id == (primary.flatMap { links[$0] != nil ? $0 : nil } ?? firstId),
                endpoints: $0.desktop.endpoints, attemptingURL: $0.attemptingURL,
                activeURL: $0.activeURL, lastSuccessfulURL: $0.desktop.lastSuccessfulURL,
                lastConnectionError: $0.lastConnectionError, recovery: $0.recovery,
                lastAddressUpdateAt: $0.desktop.lastAddressUpdateAt,
                lastAddressUpdateURL: $0.desktop.lastAddressUpdateURL)
        }
        if snapshots != desktops { desktops = snapshots }
    }

    /// Bursts of summary events publish the inbox at most once per run-loop turn and 50 ms.
    private func setNeedsInboxPublish() {
        guard inboxPublishTask == nil else { return }
        let earliest = lastInboxPublish.map { $0 + .milliseconds(50) }
        inboxPublishTask = Task { [weak self] in
            if let earliest, earliest > .now { try? await Task.sleep(until: earliest, clock: .continuous) }
            self?.publishInboxNow()
        }
    }

    private func publishInboxNow() {
        inboxPublishTask?.cancel()
        inboxPublishTask = nil
        lastInboxPublish = .now
        var seenSynced: [String: InboxItem] = [:]
        var merged: [InboxItem] = []
        var nativeIds = Set<String>()
        for byId in items.values {
            for item in byId.values {
                // A thread synced to several Macs shows once; the native copy (no origin) wins.
                if item.summary.syncOriginDeviceId == nil {
                    merged.append(item)
                    nativeIds.insert(item.summary.id)
                } else if seenSynced[item.summary.id] == nil {
                    seenSynced[item.summary.id] = item
                }
            }
        }
        merged += seenSynced.values.filter { !nativeIds.contains($0.summary.id) }
        merged.sort { $0.updatedDate != $1.updatedDate ? $0.updatedDate > $1.updatedDate : $0.id < $1.id }
        if merged != inbox { inbox = merged }
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
