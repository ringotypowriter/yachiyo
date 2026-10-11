import Combine
import Foundation

extension RemoteTask {
    public var isActive: Bool {
        state == "running" || state == "starting"
    }
}

/// A live, thread-scoped snapshot. Invalidations during a request collapse into one follow-up;
/// a late response from a closed/disconnected scope can never replace a newer snapshot.
@MainActor
public final class RemoteTaskStore: ObservableObject {
    @Published public private(set) var tasks: [RemoteTask] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var isLive = false
    @Published public private(set) var error: String?
    public var activeCount: Int { tasks.filter(\.isActive).count }

    private let load: @MainActor () async throws -> [RemoteTask]
    private var request: Task<Void, Never>?
    private var invalidation: Task<Void, Never>?
    private var generation = UUID()
    private var enabled = false
    private var refreshAgain = false

    public init(load: @escaping @MainActor () async throws -> [RemoteTask]) {
        self.load = load
    }

    public func resume() {
        enabled = true
        refresh()
    }

    public func suspend() {
        invalidation?.cancel()
        invalidation = nil
        enabled = false
        generation = UUID()
        request?.cancel()
        request = nil
        refreshAgain = false
        isLoading = false
        isLive = false
    }

    /// Log events can arrive every frame; refresh at most once per invalidation window.
    public func invalidate() {
        guard enabled, invalidation == nil else { return }
        invalidation = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard let self else { return }
            invalidation = nil
            refresh()
        }
    }

    public func refresh() {
        invalidation?.cancel()
        invalidation = nil
        guard enabled else { return }
        guard request == nil else { refreshAgain = true; return }
        let token = generation
        isLoading = true
        request = Task { [weak self, load] in
            do {
                let result = try await load()
                guard let self, generation == token, !Task.isCancelled else { return }
                tasks = result.sorted {
                    if $0.isActive != $1.isActive { return $0.isActive }
                    let left = $0.updatedAt ?? $0.startedAt
                    let right = $1.updatedAt ?? $1.startedAt
                    return left == right ? $0.id < $1.id : left > right
                }
                error = nil
                isLive = true
            } catch {
                guard let self, generation == token, !Task.isCancelled else { return }
                self.error = error.localizedDescription
                isLive = false
            }
            guard let self, generation == token else { return }
            request = nil
            isLoading = false
            if refreshAgain {
                refreshAgain = false
                refresh()
            }
        }
    }
}
