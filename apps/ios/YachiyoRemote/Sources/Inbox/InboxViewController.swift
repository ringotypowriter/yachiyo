import Combine
import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// The unified inbox: every paired Mac's threads, blocked ones first ("Needs you"), then starred,
/// then by day. Filter, search, and New live in the bottom glass toolbar.
final class InboxViewController: UIViewController {
    enum Section: Hashable {
        case needsYou
        case starred
        case day(Date)
    }

    struct Filter: Equatable {
        var desktopIds: Set<String> = []
        var running = false
        var unread = false
        var colorTags: Set<String> = []

        var isActive: Bool { !desktopIds.isEmpty || running || unread || !colorTags.isEmpty }
    }

    /// Set by the coordinator for screenshot runs: `inbox` or `thread-first`.
    var pendingRoute: String?

    private let store = RemoteStore.shared
    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Section, InboxItem>!
    private var cancellables: Set<AnyCancellable> = []
    private var filter = Filter() { didSet { applySnapshot(); updateFilterItem() } }
    private var searchQuery = ""
    private var remoteSearchHits: Set<String>?
    private var searchTask: Task<Void, Never>?
    private var isSearching = false
    private var searchFailed = false
    private var isRefreshing = false
    private var pendingMutations: Set<String> = []
    private let filterStatus = UIButton(type: .system)
    private lazy var filterItem = UIBarButtonItem(image: .lucide("list-filter"), menu: makeFilterMenu())
    private lazy var newItem = UIBarButtonItem(image: .lucide("square-pen"), primaryAction: UIAction { [weak self] _ in self?.presentNewThread() })

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Yachiyo"
        navigationItem.largeTitleDisplayMode = .always
        view.backgroundColor = .yachiyo(.app)
        configureNavigationBar()
        configureCollectionView()
        configureToolbar()
        observeStore()
        NotificationCenter.default.addObserver(self, selector: #selector(styleDidChange), name: YachiyoStyle.didChangeNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
    }

    @objc private func styleDidChange() {
        view.backgroundColor = .yachiyo(.app)
        configureNavigationBar()
        collectionView.reloadData()
    }

    private func configureNavigationBar() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithDefaultBackground()
        appearance.largeTitleTextAttributes = [.font: YachiyoFonts.largeTitle(), .foregroundColor: UIColor.label]
        appearance.titleTextAttributes = [.font: YachiyoFonts.navigationTitle(), .kern: -0.2]
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        let settings = UIBarButtonItem(image: .lucide("settings"), primaryAction: UIAction { [weak self] _ in self?.presentSettings() })
        settings.accessibilityIdentifier = "inbox.settings"
        settings.accessibilityLabel = String(localized: "Settings")
        navigationItem.rightBarButtonItem = settings
    }

    private func configureCollectionView() {
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.headerMode = .supplementary
        configuration.backgroundColor = .yachiyo(.app)
        configuration.showsSeparators = false
        configuration.leadingSwipeActionsConfigurationProvider = { [weak self] indexPath in self?.leadingSwipe(at: indexPath) }
        configuration.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in self?.trailingSwipe(at: indexPath) }
        let layout = UICollectionViewCompositionalLayout.list(using: configuration)
        collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .yachiyo(.app)
        collectionView.delegate = self
        collectionView.accessibilityIdentifier = "inbox.list"
        collectionView.refreshControl = UIRefreshControl(frame: .zero, primaryAction: UIAction { [weak self] _ in
            self?.refreshInbox()
        })
        view.addSubview(collectionView)
        YachiyoMaterialKit.applyTopEdgeEffect(to: collectionView)

        let cellRegistration = UICollectionView.CellRegistration<ThreadCell, InboxItem> { [weak self] cell, _, item in
            guard let self else { return }
            let desktop = store.desktops.first { $0.id == item.desktopId }
            cell.configure(
                item: item,
                deviceName: store.desktops.count > 1 ? desktop?.name : nil,
                isOffline: desktop?.state != .online,
                isUnread: store.unreadCompletions.contains(item.id)
            )
        }
        let headerRegistration = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] header, _, indexPath in
            guard let self, let section = dataSource.sectionIdentifier(for: indexPath.section) else { return }
            var content = UIListContentConfiguration.plainHeader()
            content.text = title(for: section)
            content.textProperties.font = YachiyoFonts.sectionTitle()
            content.textProperties.color = .yachiyo(.textMuted)
            header.contentConfiguration = content
            var background = UIBackgroundConfiguration.listPlainHeaderFooter()
            background.backgroundColor = .yachiyo(.app)
            header.backgroundConfiguration = background
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, item in
            collectionView.dequeueConfiguredReusableCell(using: cellRegistration, for: indexPath, item: item)
        }
        dataSource.supplementaryViewProvider = { collectionView, _, indexPath in
            collectionView.dequeueConfiguredReusableSupplementary(using: headerRegistration, for: indexPath)
        }
    }

    private func configureToolbar() {
        filterItem.accessibilityIdentifier = "inbox.filter"
        filterItem.accessibilityLabel = String(localized: "Filter")
        newItem.accessibilityIdentifier = "inbox.new"
        newItem.accessibilityLabel = String(localized: "New thread")
        YachiyoMaterialKit.makeProminent(newItem)

        let search = UISearchController(searchResultsController: nil)
        definesPresentationContext = true
        search.obscuresBackgroundDuringPresentation = false
        search.searchResultsUpdater = self
        search.searchBar.placeholder = String(localized: "Search threads")
        let searchItem = YachiyoMaterialKit.installSearch(search, in: navigationItem)
        var items: [UIBarButtonItem] = [filterItem, .flexibleSpace()]
        if let searchItem { items += [searchItem, .flexibleSpace()] }
        items.append(newItem)
        toolbarItems = items
    }

    private func observeStore() {
        store.$loadingInboxes
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateEmptyState(isEmpty: self?.visibleItems().isEmpty ?? true) }
            .store(in: &cancellables)
        store.$inbox
            .combineLatest(store.$desktops, store.$unreadCompletions, store.$inboxLoadErrors)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.applySnapshot()
                self?.filterItem.menu = self?.makeFilterMenu()
                self?.runPendingRoute()
            }
            .store(in: &cancellables)
    }

    // MARK: Snapshot

    private func visibleItems() -> [InboxItem] {
        store.inbox.filter { item in
            if !filter.desktopIds.isEmpty, !filter.desktopIds.contains(item.desktopId) { return false }
            if filter.running, !item.summary.isRunning { return false }
            if filter.unread, !store.unreadCompletions.contains(item.id) { return false }
            if !filter.colorTags.isEmpty, !filter.colorTags.contains(item.summary.colorTag?.rawValue ?? "") { return false }
            if !searchQuery.isEmpty {
                let local = item.summary.title.localizedCaseInsensitiveContains(searchQuery)
                    || (item.summary.preview ?? "").localizedCaseInsensitiveContains(searchQuery)
                let remote = remoteSearchHits?.contains(item.id) ?? false
                if !local, !remote { return false }
            }
            return true
        }
    }

    private func applySnapshot() {
        var snapshot = NSDiffableDataSourceSnapshot<Section, InboxItem>()
        let items = visibleItems()
        let needsYou = items.filter(\.summary.needsAttention)
        let starred = items.filter { $0.summary.starred && !$0.summary.needsAttention }
        let rest = items.filter { !$0.summary.starred && !$0.summary.needsAttention }
        if !needsYou.isEmpty {
            snapshot.appendSections([.needsYou])
            snapshot.appendItems(needsYou, toSection: .needsYou)
        }
        if !starred.isEmpty {
            snapshot.appendSections([.starred])
            snapshot.appendItems(starred, toSection: .starred)
        }
        let calendar = Calendar.current
        let byDay = Dictionary(grouping: rest) { calendar.startOfDay(for: $0.summary.updatedDate) }
        for day in byDay.keys.sorted(by: >) {
            snapshot.appendSections([.day(day)])
            snapshot.appendItems(byDay[day] ?? [], toSection: .day(day))
        }
        snapshot.reconfigureItems(snapshot.itemIdentifiers)
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)
        updateEmptyState(isEmpty: items.isEmpty)
    }

    private func updateEmptyState(isEmpty: Bool) {
        let failures = store.desktops.compactMap { desktop -> String? in
            guard let error = store.inboxLoadErrors[desktop.id] else { return nil }
            return "\(desktop.name): \(error)"
        }
        let connections = store.desktops.compactMap { store.connectionText(for: $0) }
        let loading = !store.loadingInboxes.isEmpty
        navigationItem.prompt = isEmpty ? nil : (connections.first ?? (loading ? String(localized: "Loading threads…") : (failures.isEmpty ? nil : String(localized: "Couldn't refresh threads. Pull to retry."))))
        if isEmpty, loading || !connections.isEmpty {
            let connecting = store.desktops.contains { $0.state == .connecting }
            var configuration = loading || connecting ? UIContentUnavailableConfiguration.loading() : UIContentUnavailableConfiguration.empty()
            configuration.text = loading ? String(localized: "Loading threads…") : connections.joined(separator: "\n")
            configuration.secondaryText = loading ? (connections.isEmpty ? String(localized: "Fetching your inbox from your Mac.") : connections.joined(separator: "\n")) : nil
            if !loading, !connecting, store.desktops.contains(where: { if case .offline = $0.state { return true }; return false }) {
                configuration.button = YachiyoMaterialKit.primaryButtonConfiguration(title: String(localized: "Retry"), image: nil)
                configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.refreshInbox() }
            }
            contentUnavailableConfiguration = configuration
            return
        }
        if isEmpty, !failures.isEmpty {
            var configuration = UIContentUnavailableConfiguration.empty()
            configuration.image = .lucide("triangle-alert")
            configuration.text = String(localized: "Couldn't load threads")
            configuration.secondaryText = failures.joined(separator: "\n")
            configuration.button = YachiyoMaterialKit.primaryButtonConfiguration(title: String(localized: "Retry"), image: nil)
            configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in
                self?.refreshInbox()
            }
            contentUnavailableConfiguration = configuration
            return
        }
        guard isEmpty else {
            contentUnavailableConfiguration = nil
            if searchFailed { navigationItem.prompt = String(localized: "Content search unavailable. Showing local matches.") }
            return
        }
        if filter.isActive || !searchQuery.isEmpty {
            var configuration = isSearching ? UIContentUnavailableConfiguration.loading() : UIContentUnavailableConfiguration.empty()
            configuration.text = isSearching ? String(localized: "Searching threads…") : String(localized: "No matching threads")
            configuration.secondaryText = searchFailed
                ? String(localized: "Content search couldn't finish. Local titles and previews were searched. Try searching again when your Mac is online.")
                : String(localized: "Try a different search or clear your filters.")
            if filter.isActive {
                configuration.button = YachiyoMaterialKit.primaryButtonConfiguration(title: String(localized: "Clear filters"), image: nil)
                configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.filter = Filter() }
            }
            contentUnavailableConfiguration = configuration
            return
        }
        var configuration = UIContentUnavailableConfiguration.empty()
        if store.hasDesktops {
            configuration.image = BrandAvatarView.image
            configuration.imageProperties.maximumSize = CGSize(width: 82, height: 82)
            configuration.imageProperties.cornerRadius = 41
            configuration.text = String(localized: "Creation with YACHIYO")
            configuration.textProperties.font = YachiyoFonts.display()
            configuration.secondaryText = String(localized: "Start a thread on your Mac from here.")
        } else {
            configuration.image = .lucide("qr-code")
            configuration.text = String(localized: "Pair your Mac")
            configuration.secondaryText = String(localized: "Open Settings > Remote in Yachiyo on your Mac and scan the code.")
            var button = YachiyoMaterialKit.primaryButtonConfiguration(title: String(localized: "Scan QR code"), image: nil)
            button.baseBackgroundColor = .yachiyo(.accent)
            configuration.button = button
            configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.presentPairing() }
        }
        contentUnavailableConfiguration = configuration
    }

    private func title(for section: Section) -> String {
        switch section {
        case .needsYou: return String(localized: "Needs you")
        case .starred:
            let text = String(localized: "Starred")
            return Locale.current.language.languageCode == .english ? text.uppercased() : text
        case let .day(date):
            if Calendar.current.isDateInToday(date) { return String(localized: "Today") }
            if Calendar.current.isDateInYesterday(date) { return String(localized: "Yesterday") }
            return date.formatted(.dateTime.month(.abbreviated).day())
        }
    }

    // MARK: Filter

    private func makeFilterMenu() -> UIMenu {
        var children: [UIMenuElement] = []
        if store.desktops.count > 1 {
            let devices = store.desktops.map { desktop in
                UIAction(
                    title: desktop.name,
                    image: UIImage(systemName: "circle.fill")?.withTintColor(desktop.state == .online ? .yachiyo(.success) : .yachiyo(.danger), renderingMode: .alwaysOriginal),
                    state: filter.desktopIds.contains(desktop.id) ? .on : .off
                ) { [weak self] _ in self?.toggle(\.desktopIds, desktop.id) }
            }
            children.append(UIMenu(title: String(localized: "Devices"), options: .displayInline, children: devices))
        }
        children.append(UIMenu(options: .displayInline, children: [
            UIAction(title: String(localized: "Running"), state: filter.running ? .on : .off) { [weak self] _ in self?.filter.running.toggle(); UISelectionFeedbackGenerator().selectionChanged() },
            UIAction(title: String(localized: "Completed"), state: filter.unread ? .on : .off) { [weak self] _ in self?.filter.unread.toggle(); UISelectionFeedbackGenerator().selectionChanged() },
        ]))
        let tags = ["coral", "azure", "emerald", "amethyst", "slate"].map { tag in
            UIAction(
                title: tag.capitalized,
                image: UIImage(systemName: "circle.fill")?.withTintColor(.yachiyoColorTag(tag) ?? .gray, renderingMode: .alwaysOriginal),
                state: filter.colorTags.contains(tag) ? .on : .off
            ) { [weak self] _ in self?.toggle(\.colorTags, tag) }
        }
        children.append(UIMenu(title: String(localized: "Color"), options: .displayInline, children: tags))
        if filter.isActive {
            children.append(UIAction(title: String(localized: "Clear filters"), image: UIImage(systemName: "xmark"), attributes: .destructive) { [weak self] _ in self?.filter = Filter() })
        }
        return UIMenu(children: children)
    }

    private func toggle(_ keyPath: WritableKeyPath<Filter, Set<String>>, _ value: String) {
        if filter[keyPath: keyPath].contains(value) {
            filter[keyPath: keyPath].remove(value)
        } else {
            filter[keyPath: keyPath].insert(value)
        }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func updateFilterItem() {
        filterItem.menu = makeFilterMenu()
        filterItem.tintColor = filter.isActive ? .yachiyo(.accentStrong) : nil
    }

    // MARK: Swipe

    private func refreshInbox() {
        guard !isRefreshing else { return }
        isRefreshing = true
        Task {
            await store.refreshInbox()
            isRefreshing = false
            collectionView.refreshControl?.endRefreshing()
        }
    }

    private func canMutate(_ item: InboxItem) -> Bool {
        !item.summary.isReadOnly && !pendingMutations.contains(item.id)
            && store.link(for: item.desktopId)?.state == .online
    }

    private func mutate(_ item: InboxItem, archive: Bool, completion: @escaping (Bool) -> Void) {
        guard canMutate(item) else { completion(false); return }
        pendingMutations.insert(item.id)
        Task {
            defer { pendingMutations.remove(item.id) }
            let thread = ThreadStore(desktopId: item.desktopId, threadId: item.summary.id)
            let succeeded: Bool
            if archive {
                succeeded = await thread.archive()
            } else {
                await thread.setStarred(!item.summary.starred)
                succeeded = thread.lastError == nil
            }
            completion(succeeded)
            if let error = thread.lastError, presentedViewController == nil || presentedViewController is UISearchController {
                let alert = UIAlertController(title: String(localized: "Couldn't update thread"), message: error, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default))
                (presentedViewController ?? self).present(alert, animated: true)
            }
        }
    }

    private func confirmArchive(_ item: InboxItem, completion: @escaping (Bool) -> Void) {
        guard canMutate(item), presentedViewController == nil || presentedViewController is UISearchController else { completion(false); return }
        let alert = UIAlertController(title: String(localized: "Archive thread?"), message: item.summary.title, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { _ in completion(false) })
        alert.addAction(UIAlertAction(title: String(localized: "Archive"), style: .destructive) { [weak self] _ in
            guard let self else { completion(false); return }
            self.mutate(item, archive: true, completion: completion)
        })
        (presentedViewController ?? self).present(alert, animated: true)
    }

    private func leadingSwipe(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let item = dataSource.itemIdentifier(for: indexPath), canMutate(item) else { return nil }
        let action = UIContextualAction(style: .normal, title: item.summary.starred ? String(localized: "Unstar") : String(localized: "Star")) { [weak self] _, _, done in
            guard let self else { done(false); return }
            self.mutate(item, archive: false, completion: done)
        }
        action.image = .lucide("star")
        action.backgroundColor = .yachiyo(.warning)
        return UISwipeActionsConfiguration(actions: [action])
    }

    private func trailingSwipe(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let item = dataSource.itemIdentifier(for: indexPath), canMutate(item) else { return nil }
        let action = UIContextualAction(style: .destructive, title: String(localized: "Archive")) { [weak self] _, _, done in
            guard let self else { done(false); return }
            self.confirmArchive(item, completion: done)
        }
        action.image = .lucide("archive")
        let configuration = UISwipeActionsConfiguration(actions: [action])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    // MARK: Navigation

    func open(_ item: InboxItem) {
        guard navigationController?.topViewController === self, presentedViewController == nil || presentedViewController is UISearchController else { return }
        // Opening cached history is local; only mutations require an online Mac.
        let controller = ThreadViewController(desktopId: item.desktopId, threadId: item.summary.id)
        navigationController?.pushViewController(controller, animated: true)
    }

    private func presentNewThread() {
        if let search = presentedViewController as? UISearchController {
            search.dismiss(animated: true) { [weak self] in self?.presentNewThread() }
            return
        }
        guard presentedViewController == nil else { return }
        let controller = NewThreadViewController()
        controller.onStarted = { [weak self] desktopId, thread in
            self?.dismiss(animated: true) {
                self?.navigationController?.pushViewController(ThreadViewController(desktopId: desktopId, threadId: thread.id), animated: true)
            }
        }
        let container = UINavigationController(rootViewController: controller)
        container.modalPresentationStyle = .pageSheet
        YachiyoMaterialKit.prepareZoomTransition(for: container, from: newItem)
        YachiyoMaterialKit.configureSheet(container, detents: [.large()])
        present(container, animated: true)
    }

    private func presentSettings() {
        if let search = presentedViewController as? UISearchController {
            search.dismiss(animated: true) { [weak self] in self?.presentSettings() }
            return
        }
        guard presentedViewController == nil else { return }
        let container = UINavigationController(rootViewController: SettingsViewController())
        YachiyoMaterialKit.configureSheet(container, detents: [.large()])
        present(container, animated: true)
    }

    private func presentPairing() {
        guard presentedViewController == nil else { return }
        let pairing = PairingViewController(initialURL: nil)
        pairing.onFinished = { [weak self] in self?.dismiss(animated: true) }
        let container = UINavigationController(rootViewController: pairing)
        container.modalPresentationStyle = .fullScreen
        present(container, animated: true)
    }

    /// `thread-first` opens the top thread; `thread:<id>` opens that thread once it is listed.
    private func runPendingRoute() {
        guard let route = pendingRoute else { return }
        let items = visibleItems()
        let target = route == "thread-first"
            ? items.first
            : route.hasPrefix("thread:") ? items.first { $0.summary.id == route.dropFirst("thread:".count) } : nil
        guard let target else { return }
        pendingRoute = nil
        open(target)
    }
}

extension InboxViewController: UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard let item = dataSource.itemIdentifier(for: indexPath), canMutate(item) else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            UIMenu(children: [
                UIAction(title: item.summary.starred ? String(localized: "Unstar") : String(localized: "Star"), image: .lucide("star")) { _ in
                    self?.mutate(item, archive: false) { _ in }
                },
                UIAction(title: String(localized: "Archive"), image: .lucide("archive"), attributes: .destructive) { _ in
                    self?.confirmArchive(item) { _ in }
                },
            ])
        }
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        guard let item = dataSource.itemIdentifier(for: indexPath) else { return }
        open(item)
    }
}

extension InboxViewController: UISearchResultsUpdating {
    func updateSearchResults(for searchController: UISearchController) {
        searchQuery = searchController.searchBar.text?.trimmingCharacters(in: .whitespaces) ?? ""
        remoteSearchHits = nil
        isSearching = !searchQuery.isEmpty
        searchFailed = false
        applySnapshot()
        searchTask?.cancel()
        guard !searchQuery.isEmpty else { return }
        let query = searchQuery
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(280))
            guard let self, !Task.isCancelled else { return }
            var hits = Set<String>()
            var failed = !store.desktops.contains { $0.state == .online }
            for desktop in store.desktops where desktop.state == .online {
                let output: RemoteThreadsSearchOutput? = try? await store.call(desktop.id, "threads.search", SearchInput(query: query))
                guard !Task.isCancelled else { return }
                if output == nil { failed = true }
                for result in output?.results ?? [] { hits.insert("\(desktop.id)/\(result.threadId)") }
            }
            guard !Task.isCancelled, query == searchQuery else { return }
            remoteSearchHits = hits
            isSearching = false
            searchFailed = failed
            applySnapshot()
        }
    }
}

struct SearchInput: Encodable { let query: String }
