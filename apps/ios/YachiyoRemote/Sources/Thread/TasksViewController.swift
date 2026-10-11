import Combine
import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// A compact live task shelf, separate from both the transcript and the response's run state.
final class TasksViewController: UITableViewController {
    private let tasks: RemoteTaskStore
    private var sections: [[RemoteTask]] = [[], []]
    private var cancellables: Set<AnyCancellable> = []

    init(tasks: RemoteTaskStore) {
        self.tasks = tasks
        super.init(style: .insetGrouped)
        title = "Tasks"
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = .yachiyo(.canvas)
        tableView.accessibilityIdentifier = "tasks.list"
        tableView.register(TaskCell.self, forCellReuseIdentifier: "task")
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 120
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        navigationItem.leftBarButtonItem = UIBarButtonItem(image: .lucide("rotate-ccw"), primaryAction: UIAction { [weak self] _ in
            self?.refresh()
        })
        navigationItem.leftBarButtonItem?.accessibilityLabel = "Refresh tasks"
        refreshControl = UIRefreshControl()
        refreshControl?.addAction(UIAction { [weak self] _ in self?.refresh() }, for: .valueChanged)
        tasks.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.render() }
            .store(in: &cancellables)
        render()
        tasks.refresh()
    }

    private func refresh() {
        tasks.refresh()
        render()
    }

    private func render() {
        let next = [tasks.tasks.filter(\.isActive), tasks.tasks.filter { !$0.isActive }]
        if sections != next {
            sections = next
            tableView.reloadData()
        }
        navigationItem.leftBarButtonItem?.isEnabled = !tasks.isLoading
        if !tasks.isLoading { refreshControl?.endRefreshing() }
        if tasks.tasks.isEmpty {
            var empty = UIContentUnavailableConfiguration.empty()
            empty.image = .lucide("square-terminal")
            empty.text = tasks.isLoading ? "Loading tasks…" : (tasks.error != nil ? "Couldn't load tasks" : (tasks.isLive ? "No tasks yet" : "Tasks unavailable"))
            empty.secondaryText = tasks.error ?? (tasks.isLive
                ? "Background commands and workers will appear here."
                : "Tasks will update when your Mac reconnects.")
            let placeholder = UIContentUnavailableView(configuration: empty)
            placeholder.isAccessibilityElement = true
            placeholder.accessibilityIdentifier = "tasks.empty"
            placeholder.accessibilityLabel = [empty.text, empty.secondaryText].compactMap { $0 }.joined(separator: ". ")
            tableView.backgroundView = placeholder
        } else {
            tableView.backgroundView = nil
        }
        // A stale running snapshot must never look like a live execution indicator.
        let notice = tasks.tasks.isEmpty ? nil : (tasks.error.map { "Couldn't refresh tasks. \($0)" }
            ?? (!tasks.isLive && !tasks.isLoading ? "Offline · Showing the last task update" : nil))
        if let notice {
            let label = UILabel()
            label.text = notice
            label.font = YachiyoFonts.meta()
            label.textColor = .secondaryLabel
            label.numberOfLines = 0
            label.textAlignment = .center
            let header = UIView()
            header.addSubview(label)
            tableView.tableHeaderView = header
            layoutNotice()
        } else {
            tableView.tableHeaderView = nil
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutNotice()
    }

    private func layoutNotice() {
        guard let header = tableView.tableHeaderView, let label = header.subviews.first as? UILabel else { return }
        let width = max(0, tableView.bounds.width - 40)
        let height = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        label.frame = CGRect(x: 20, y: 8, width: width, height: height)
        if header.frame.width != tableView.bounds.width || header.frame.height != height + 24 {
            header.frame = CGRect(x: 0, y: 0, width: tableView.bounds.width, height: height + 24)
            tableView.tableHeaderView = header
        }
    }

    override func numberOfSections(in _: UITableView) -> Int { sections.count }
    override func tableView(_: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].count }
    override func tableView(_: UITableView, titleForHeaderInSection section: Int) -> String? {
        guard !sections[section].isEmpty else { return nil }
        return section == 0 ? "Running · \(sections[section].count)" : "Recent"
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "task", for: indexPath) as! TaskCell
        cell.configure(sections[indexPath.section][indexPath.row])
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        navigationController?.sheetPresentationController?.animateChanges {
            self.navigationController?.sheetPresentationController?.selectedDetentIdentifier = .large
        }
        navigationController?.pushViewController(TaskOutputViewController(tasks: tasks, task: sections[indexPath.section][indexPath.row]), animated: true)
    }
}

private extension RemoteTask {
    var statusColor: UIColor {
        if state == "failed" { return .yachiyo(.dangerStrong) }
        if isActive { return .yachiyo(.accent) }
        return state == "completed" || state == "idle" ? .yachiyo(.successStrong) : .secondaryLabel
    }
    var statusText: String { state.replacingOccurrences(of: "-", with: " ").capitalized }
    var kindText: String { kind == .background ? "Background command" : "Worker" }
}

private final class TaskCell: UITableViewCell {
    private let icon = UIImageView()
    private let taskTitle = UILabel()
    private let metadata = UILabel()
    private let output = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        accessoryType = .disclosureIndicator
        backgroundColor = .yachiyo(.surface)
        icon.contentMode = .center
        icon.layer.cornerRadius = 12
        taskTitle.font = YachiyoFonts.body()
        taskTitle.numberOfLines = 2
        taskTitle.adjustsFontForContentSizeCategory = true
        metadata.font = YachiyoFonts.caption()
        metadata.numberOfLines = 0
        metadata.adjustsFontForContentSizeCategory = true
        output.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: .monospacedSystemFont(ofSize: 12, weight: .regular))
        output.adjustsFontForContentSizeCategory = true
        output.textColor = .secondaryLabel
        output.numberOfLines = 2
        let text = UIStackView(arrangedSubviews: [taskTitle, metadata, output])
        text.axis = .vertical
        text.spacing = 5
        text.setCustomSpacing(10, after: metadata)
        let row = UIStackView(arrangedSubviews: [icon, text])
        row.alignment = .top
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(row)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 38),
            icon.heightAnchor.constraint(equalToConstant: 38),
            row.leadingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 16),
            row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -16),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func configure(_ task: RemoteTask) {
        icon.image = .lucide(task.kind == .background ? "square-terminal" : "network")
        icon.tintColor = task.statusColor
        icon.backgroundColor = task.statusColor.withAlphaComponent(0.10)
        taskTitle.text = task.title
        taskTitle.textColor = .yachiyo(.ink)
        metadata.text = "\(task.statusText) · \(task.kindText)"
        metadata.textColor = task.statusColor
        output.text = task.progress?.split(separator: "\n", omittingEmptySubsequences: true).suffix(2).joined(separator: "\n")
        output.isHidden = output.text?.isEmpty != false
        accessibilityIdentifier = "tasks.task.\(task.id)"
    }
}

private final class TaskOutputViewController: UIViewController {
    private let tasks: RemoteTaskStore
    private var task: RemoteTask
    private let textView = UITextView()
    private var cancellables: Set<AnyCancellable> = []

    init(tasks: RemoteTaskStore, task: RemoteTask) {
        self.tasks = tasks
        self.task = task
        super.init(nibName: nil, bundle: nil)
        title = "Task details"
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .yachiyo(.canvas)
        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.accessibilityIdentifier = "tasks.output"
        textView.textContainerInset = UIEdgeInsets(top: 20, left: 20, bottom: 32, right: 20)
        textView.frame = view.bounds
        textView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(textView)
        tasks.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                if let current = tasks.tasks.first(where: { $0.id == self.task.id }) { task = current }
                render()
            }
            .store(in: &cancellables)
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self]) { (reader: TaskOutputViewController, _: UITraitCollection) in reader.render() }
        render()
    }

    private func render() {
        let content = NSMutableAttributedString(string: "")
        func append(_ text: String, font: UIFont, color: UIColor) {
            content.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color]))
        }
        append(task.title + "\n\n", font: YachiyoFonts.sectionTitle(), color: .yachiyo(.ink))
        append("\(task.statusText) · \(task.kindText)\n", font: YachiyoFonts.meta(), color: task.statusColor)
        if let date = task.startedAt.isoDate {
            append("Started \(date.formatted(date: .abbreviated, time: .shortened))\n", font: YachiyoFonts.caption(), color: .secondaryLabel)
        }
        if !tasks.isLive { append("Not live · Showing the last update\n", font: YachiyoFonts.caption(), color: .secondaryLabel) }
        append("\nRecent output\n\n", font: YachiyoFonts.meta(), color: .secondaryLabel)
        append(task.progress?.isEmpty == false ? task.progress! : "No output yet.", font: UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular)), color: .yachiyo(.ink))
        guard !content.isEqual(to: textView.attributedText) else { return }
        let offset = textView.contentOffset
        let selection = textView.selectedRange
        textView.attributedText = content
        let location = min(selection.location, content.length)
        textView.selectedRange = NSRange(location: location, length: min(selection.length, content.length - location))
        textView.layoutIfNeeded()
        textView.setContentOffset(offset, animated: false)
    }
}
