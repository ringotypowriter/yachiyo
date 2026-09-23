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
}

/// App-wide remote state: paired desktops, their connections, and the merged inbox. Thread
/// pages subscribe to `threadEvents` for their thread and ask for thread-scope events.
@MainActor
final class RemoteStore {
    static let shared = RemoteStore(credentials: KeychainCredentialStore())
    private static let logger = Logger(subsystem: "sh.ringo.yachiyo.remote", category: "Inbox")

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

    private var openThread: (desktopId: String, threadId: String)?
    private lazy var connector = DesktopConnector(identity: identity(), mailbox: MailboxFolder.source())

    init(credentials: RemoteCredentialStore) {
        self.credentials = credentials
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
        resume()
    }

    func resume() {
        for link in links.values { link.start() }
    }

    func suspend() {
        for link in links.values { link.stop() }
    }

    // MARK: Pairing

    @discardableResult
    func pair(url: URL) async throws -> DesktopSnapshot {
        let payload = try PairingURL.decode(url)
        let (client, desktop, hello) = try await connector.pair(payload)
        try credentials.save(desktop)
        links[desktop.remoteDeviceId]?.stop()
        let link = makeLink(desktop, client: client, hello: hello)
        links[desktop.remoteDeviceId] = link
        link.start()
        publishDesktops()
        return desktops.first { $0.id == desktop.remoteDeviceId }!
    }

    func remove(desktopId: String) {
        links[desktopId]?.stop()
        links[desktopId] = nil
        summaries[desktopId] = nil
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

    func refreshInbox() async {
        for link in links.values where link.state == .online {
            await reloadSummaries(for: link)
        }
    }

    /// Declares the thread on screen so its desktop streams thread-scope events.
    func setOpenThread(desktopId: String?, threadId: String?) {
        if let previous = openThread, previous.desktopId != desktopId {
            links[previous.desktopId]?.watch(threadIds: [])
        }
        if let desktopId, let threadId {
            openThread = (desktopId, threadId)
            links[desktopId]?.watch(threadIds: [threadId])
            unreadCompletions.remove("\(desktopId)/\(threadId)")
        } else {
            openThread = nil
        }
    }

    func summary(desktopId: String, threadId: String) -> RemoteThreadSummary? {
        summaries[desktopId]?[threadId]
    }

    func upsert(desktopId: String, summary: RemoteThreadSummary) {
        summaries[desktopId, default: [:]][summary.id] = summary
        publishInbox()
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
        DesktopLink(
            desktop: desktop,
            connector: connector,
            client: client,
            hello: hello,
            onChange: { [weak self] link in self?.linkDidChange(link) },
            onEvent: { [weak self] link, event in self?.handle(event, from: link) },
            onResync: { [weak self] link in
                guard let self else { return }
                Task { await self.reloadSummaries(for: link) }
                resyncs.send(link.id)
            },
            persist: { [weak self] desktop in try? self?.credentials.save(desktop) }
        )
    }

    private func linkDidChange(_ link: DesktopLink) {
        publishDesktops()
        if link.state == .online {
            Task { await reloadSummaries(for: link) }
            if link.id == primaryDesktopId { refreshAppearance() }
        } else {
            publishInbox()
        }
    }

    private func reloadSummaries(for link: DesktopLink) async {
        do {
            var collected: [RemoteThreadSummary] = []
            var cursor: String?
            repeat {
                let page: RemoteThreadsListOutput = try await link.call("threads.list", ThreadsListInput(cursor: cursor, limit: 200))
                collected += page.threads
                cursor = page.nextCursor
            } while cursor != nil
            summaries[link.id] = Dictionary(uniqueKeysWithValues: collected.map { ($0.id, $0) })
            inboxLoadErrors[link.id] = nil
            publishInbox()
        } catch {
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
        if let threadId = event.threadId, openThread?.desktopId == link.id, openThread?.threadId == threadId {
            threadEvents.send((link.id, event))
        } else if event.type == .threadInvalidated || event.type == .runStatus {
            threadEvents.send((link.id, event))
        }
    }

    private func publishDesktops() {
        let primary = UserDefaults.standard.string(forKey: "primaryDesktopId")
        let sorted = links.values.sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        let firstId = sorted.first?.id
        desktops = sorted.map {
            DesktopSnapshot(id: $0.id, name: $0.displayName, state: $0.state, isPrimary: $0.id == (primary.flatMap { links[$0] != nil ? $0 : nil } ?? firstId))
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
