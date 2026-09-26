import Combine
import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

private final class InboxSectionHeader: UICollectionReusableView {
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func configure(title: String) {
        label.text = title
        label.font = YachiyoFonts.sectionTitle()
        label.textColor = .yachiyo(.textMuted)
    }
}

/// The selected Mac's inbox: its threads, blocked ones first ("Needs you"), then starred,
/// then by day. Filter, search, and New live in the bottom glass toolbar.
final class InboxViewController: UIViewController {
    enum Section: Hashable {
        case needsYou
        case starred
        case day(Date)
    }

    struct Filter: Equatable {
        var running = false
        var unread = false
        var colorTags: Set<String> = []

        var isActive: Bool { running || unread || !colorTags.isEmpty }
    }

    /// Set by the coordinator for screenshot runs: `inbox` or `thread-first`.
    var pendingRoute: String?

    private let store = RemoteStore.shared
    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Section, InboxItem>!
    private var cancellables: Set<AnyCancellable> = []
    private var filter = Filter() { didSet { applySnapshot(); updateFilterItem() } }
    private var selectedDesktopId: String?
    private var selectedConnectionState: DesktopConnectionState?
    private var renderedConnectionState: DesktopConnectionState?
    private var renderedUnreadCompletions: Set<String> = []
    private var selectedDesktop: DesktopSnapshot? { store.desktops.first { $0.id == selectedDesktopId } }
    private var searchQuery = ""
    private var remoteSearchHits: Set<String>?
    private var searchTask: Task<Void, Never>?
    private var isSearching = false
    private var searchFailed = false
    private var refreshingDesktopIds: Set<String> = []
    private var pendingMutations: Set<String> = []
    private var readingDelayTask: Task<Void, Never>?
    private var showsReadingStatus = false
    private var readingDesktopId: String?
    /// Store changes that arrived while the inbox was off screen, applied when it reappears.
    private var needsStoreRefresh = false
    private let desktopButton = UIButton(type: .system)
    private let filterStatus = UIButton(type: .system)
    private lazy var filterItem = UIBarButtonItem(image: .lucide("list-filter"), menu: makeFilterMenu())
    private lazy var newItem = UIBarButtonItem(image: .lucide("square-pen"), primaryAction: UIAction { [weak self] _ in self?.presentNewThread() })

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .never
        view.backgroundColor = .yachiyo(.app)
        configureNavigationBar()
        configureCollectionView()
        configureToolbar()
        synchronizeDesktop()
        observeStore()
        NotificationCenter.default.addObserver(self, selector: #selector(styleDidChange), name: YachiyoStyle.didChangeNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        if needsStoreRefresh { refreshFromStore() }
    }

    @objc private func styleDidChange() {
        view.backgroundColor = .yachiyo(.app)
        configureNavigationBar()
        collectionView.reloadData()
    }

    private func configureNavigationBar() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithDefaultBackground()
        appearance.titleTextAttributes = [.font: YachiyoFonts.navigationTitle(), .kern: -0.2]
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        desktopButton.titleLabel?.font = YachiyoFonts.largeTitle()
        desktopButton.titleLabel?.numberOfLines = 0
        desktopButton.titleLabel?.lineBreakMode = .byWordWrapping
        desktopButton.contentHorizontalAlignment = .leading
        desktopButton.tintColor = .label
        desktopButton.setTitleColor(.label, for: .normal)
        desktopButton.setImage(.lucide("chevron-down"), for: .normal)
        desktopButton.semanticContentAttribute = .forceRightToLeft
        desktopButton.accessibilityIdentifier = "inbox.desktop"
        desktopButton.showsMenuAsPrimaryAction = true
        desktopButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.makeDesktopMenu().children ?? [])
        }])
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
        let layout = UICollectionViewCompositionalLayout { _, environment in
            let section = NSCollectionLayoutSection.list(using: configuration, layoutEnvironment: environment)
            section.boundarySupplementaryItems.forEach { $0.pinToVisibleBounds = false }
            return section
        }
        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = .yachiyo(.app)
        collectionView.delegate = self
        collectionView.accessibilityIdentifier = "inbox.list"
        collectionView.refreshControl = UIRefreshControl(frame: .zero, primaryAction: UIAction { [weak self] _ in
            self?.refreshInbox()
        })
        desktopButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(desktopButton)
        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            desktopButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            desktopButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            desktopButton.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            collectionView.topAnchor.constraint(equalTo: desktopButton.bottomAnchor, constant: 8),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        YachiyoMaterialKit.applyTopEdgeEffect(to: collectionView)

        let cellRegistration = UICollectionView.CellRegistration<ThreadCell, InboxItem> { [weak self] cell, _, item in
            guard let self else { return }
            let desktop = store.desktops.first { $0.id == item.desktopId }
            cell.configure(
                item: item,
                deviceName: nil,
                isOffline: desktop?.state != .online,
                isUnread: store.unreadCompletions.contains(item.id)
            )
        }
        let headerRegistration = UICollectionView.SupplementaryRegistration<InboxSectionHeader>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] header, _, indexPath in
            guard let self, let section = dataSource.sectionIdentifier(for: indexPath.section) else { return }
            header.configure(title: title(for: section))
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
            .sink { [weak self] _ in
                guard let self else { return }
                guard view.window != nil else { needsStoreRefresh = true; return }
                updateEmptyState(isEmpty: visibleItems().isEmpty)
            }
            .store(in: &cancellables)
        // Bursts (resync pages, several runs finishing) collapse into one snapshot.
        store.$inbox
            .combineLatest(store.$desktops, store.$unreadCompletions, store.$inboxLoadErrors)
            .throttle(for: .milliseconds(100), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] _ in
                guard let self else { return }
                guard view.window != nil else { needsStoreRefresh = true; return }
                refreshFromStore()
            }
            .store(in: &cancellables)
    }

    private func refreshFromStore() {
        needsStoreRefresh = false
        synchronizeDesktop()
        applySnapshot()
        runPendingRoute()
    }

    private func synchronizeDesktop(preferredId: String? = nil) {
        let resolved = RemoteDesktopSelection.resolve(
            savedId: preferredId ?? selectedDesktopId ?? UserDefaults.standard.string(forKey: "inboxDesktopId"),
            desktopIds: store.desktops.map(\.id),
            primaryId: store.primaryDesktopId
        )
        let state = store.desktops.first { $0.id == resolved }?.state
        if resolved != selectedDesktopId || state != selectedConnectionState {
            selectedDesktopId = resolved
            selectedConnectionState = state
            // The controller can load before RemoteStore.bootstrap populates paired desktops.
            if let resolved { UserDefaults.standard.set(resolved, forKey: "inboxDesktopId") }
            restartSearch()
        }
        if let selectedDesktopId, refreshingDesktopIds.contains(selectedDesktopId) {
            collectionView.refreshControl?.beginRefreshing()
        } else {
            collectionView.refreshControl?.endRefreshing()
        }
        desktopButton.setTitle(selectedDesktop?.name ?? "Yachiyo", for: .normal)
        desktopButton.isEnabled = !store.desktops.isEmpty
    }

    private func makeDesktopMenu() -> UIMenu {
        UIMenu(children: store.desktops.map { desktop in
            let action = UIAction(
                title: desktop.name,
                image: .lucide("monitor"),
                state: desktop.id == selectedDesktopId ? .on : .off
            ) { [weak self] _ in
                guard let self, selectedDesktopId != desktop.id else { return }
                synchronizeDesktop(preferredId: desktop.id)
                UISelectionFeedbackGenerator().selectionChanged()
            }
            action.subtitle = store.connectionText(for: desktop)
            return action
        })
    }

    // MARK: Snapshot

    private func visibleItems() -> [InboxItem] {
        let query = InboxItem.searchKey(searchQuery)
        return store.inbox.filter { item in
            guard item.desktopId == selectedDesktopId else { return false }
            if filter.running, !item.summary.isRunning { return false }
            if filter.unread, !store.unreadCompletions.contains(item.id) { return false }
            if !filter.colorTags.isEmpty, !filter.colorTags.contains(item.summary.colorTag?.rawValue ?? "") { return false }
            if !query.isEmpty {
                let local = item.searchTitle.contains(query) || item.searchPreview.contains(query)
                let remote = remoteSearchHits?.contains(item.id) ?? false
                if !local, !remote { return false }
            }
            return true
        }
    }

    private func applySnapshot() {
        let previous = Dictionary(uniqueKeysWithValues: dataSource.snapshot().itemIdentifiers.map { ($0.id, $0) })
        let changedUnread = renderedUnreadCompletions.symmetricDifference(store.unreadCompletions)
        let connectionChanged = renderedConnectionState != selectedConnectionState
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
        let byDay = Dictionary(grouping: rest) { calendar.startOfDay(for: $0.updatedDate) }
        for day in byDay.keys.sorted(by: >) {
            snapshot.appendSections([.day(day)])
            snapshot.appendItems(byDay[day] ?? [], toSection: .day(day))
        }
        snapshot.reconfigureItems(snapshot.itemIdentifiers.filter {
            previous[$0.id] != nil && (connectionChanged || changedUnread.contains($0.id) || previous[$0.id]?.summary != $0.summary)
        })
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)
        renderedConnectionState = selectedConnectionState
        renderedUnreadCompletions = store.unreadCompletions
        updateEmptyState(isEmpty: items.isEmpty)
    }

    private func updateEmptyState(isEmpty: Bool) {
        let desktops = selectedDesktop.map { [$0] } ?? []
        let failures = desktops.compactMap { desktop -> String? in
            guard let error = store.inboxLoadErrors[desktop.id] else { return nil }
            return "\(desktop.name): \(error)"
        }
        let loading = selectedDesktopId.map { store.loadingInboxes.contains($0) } ?? false
        let connecting = desktops.contains { $0.state == .connecting }
        let waitingForInbox = isEmpty && (loading || connecting)
        if !waitingForInbox || readingDesktopId != selectedDesktopId {
            readingDelayTask?.cancel()
            readingDelayTask = nil
            showsReadingStatus = false
            readingDesktopId = selectedDesktopId
        }
        if waitingForInbox, readingDelayTask == nil, !showsReadingStatus {
            readingDelayTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(700))
                guard !Task.isCancelled else { return }
                self?.readingDelayTask = nil
                self?.showsReadingStatus = true
                self?.updateEmptyState(isEmpty: self?.visibleItems().isEmpty ?? true)
            }
        }
        navigationItem.prompt = nil
        if waitingForInbox && !showsReadingStatus {
            contentUnavailableConfiguration = nil
            return
        }
        if isEmpty, loading || connecting || desktops.contains(where: { $0.state != .online }) {
            var configuration = loading || connecting ? UIContentUnavailableConfiguration.loading() : UIContentUnavailableConfiguration.empty()
            configuration.text = loading || connecting ? String(localized: "Loading threads…") : (desktops.first.flatMap { store.connectionText(for: $0) } ?? String(localized: "Your Mac is offline"))
            configuration.secondaryText = nil
            if !loading, !connecting, desktops.contains(where: { if case .offline = $0.state { return true }; return false }) {
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
        if selectedDesktop != nil, filter.isActive || !searchQuery.isEmpty {
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
        guard let desktopId = selectedDesktopId else {
            collectionView.refreshControl?.endRefreshing()
            return
        }
        guard refreshingDesktopIds.insert(desktopId).inserted else { return }
        Task {
            await store.refreshInbox(desktopId: desktopId)
            refreshingDesktopIds.remove(desktopId)
            if desktopId == selectedDesktopId { collectionView.refreshControl?.endRefreshing() }
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
            var failure: String?
            do {
                if archive {
                    try await store.archive(desktopId: item.desktopId, threadId: item.summary.id)
                } else {
                    try await store.setStarred(desktopId: item.desktopId, threadId: item.summary.id, starred: !item.summary.starred)
                }
            } catch {
                failure = (error as? RemoteCallError)?.message ?? error.localizedDescription
            }
            completion(failure == nil)
            if let error = failure, presentedViewController == nil || presentedViewController is UISearchController {
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
        guard let selectedDesktopId else { presentPairing(); return }
        let controller = NewThreadViewController(desktopId: selectedDesktopId)
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
        restartSearch()
    }

    private func restartSearch() {
        remoteSearchHits = nil
        isSearching = !searchQuery.isEmpty && selectedDesktopId != nil
        searchFailed = false
        applySnapshot()
        searchTask?.cancel()
        guard !searchQuery.isEmpty, let desktopId = selectedDesktopId else { isSearching = false; return }
        let query = searchQuery
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(280))
            guard let self, !Task.isCancelled else { return }
            var hits = Set<String>()
            var failed = true
            if store.desktops.contains(where: { $0.id == desktopId && $0.state == .online }) {
                let output: RemoteThreadsSearchOutput? = try? await store.call(desktopId, "threads.search", SearchInput(query: query))
                guard !Task.isCancelled else { return }
                failed = output == nil
                for result in output?.results ?? [] { hits.insert("\(desktopId)/\(result.threadId)") }
            }
            guard !Task.isCancelled, query == searchQuery, desktopId == selectedDesktopId else { return }
            remoteSearchHits = hits
            isSearching = false
            searchFailed = failed
            applySnapshot()
        }
    }
}

struct SearchInput: Encodable { let query: String }
