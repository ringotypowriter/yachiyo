import ListViewKit
import UIKit
import XCTest
@testable import YachiyoChatUI

@MainActor
final class ResponseViewSizingTests: XCTestCase {
    func testAssistantRowHeightMatchesRenderedMarkdownAtPhoneWidths() throws {
        let list = MessageListView()
        list.applyYachiyoTheme()
        let message = MessageListView.ResponseChunk(
            messageId: "assistant", index: 0,
            content: String(repeating: """
            1. **Primary 不是唯一活动设备**：它主要决定新建会话的默认目标，以及手机跟随哪台桌面端的外观；其他设备仍然同时连接。
            2. **Forget 不等于撤销授权**：手机端忘记设备只是移除本机记录；要真正撤销这台手机的访问权限，需要到 Mac 的 Settings → Remote 操作。

            核心实现集中在 `RemoteStore.swift`、`DesktopLink.swift` 和 `DeviceViewController.swift`。整体更像一个聚合多台独立 Yachiyo 实例的遥控器，不是跨设备共享同一个运行实例。

            """, count: 3),
            endsInsideFence: false
        )
        let entry = MessageListView.Entry.response(message)
        list.dataSource.applySnapshot(using: [entry], animatingDifferences: false)
        let timeline = try XCTUnwrap(list.scrollView as? ListView)
        let row = try XCTUnwrap(list.listViewMakeRow(for: list.listView(timeline, rowKindFor: entry, at: 0)) as? ResponseView)

        for width: CGFloat in [320, 390, 430] {
            timeline.frame.size.width = width
            let height = list.listView(timeline, heightFor: entry, at: 0)
            list.listView(timeline, configureRowView: row, for: entry, at: 0)
            row.frame = CGRect(x: 0, y: 0, width: width, height: height)
            row.layoutIfNeeded()
            // Flush the same document synchronously so this geometry assertion does
            // not depend on MarkdownView's streaming throttle or the run loop.
            row.markdownView.setMarkdownManually(list.markdownPackageCache.package(for: entry.id, content: message.content, theme: list.markdownTheme))
            let renderedHeight = ceil(row.markdownView.boundingSize(for: row.contentView.bounds.width).height)
            XCTAssertEqual(height - renderedHeight, MessageListView.listRowInsets.bottom, accuracy: 1,
                           "The next message must follow the rendered response, not a differently themed measurement")
        }
    }

    func testReusedResponseReceivesChangedTheme() {
        let row = ResponseView()
        row.theme = MessageListView.yachiyoMarkdownTheme()
        XCTAssertEqual(row.markdownView.theme, row.theme)
        var changed = row.theme
        changed.fonts.body = .systemFont(ofSize: 28)
        changed.spacings.general = 24
        row.theme = changed
        XCTAssertEqual(row.markdownView.theme, changed)
    }
}
