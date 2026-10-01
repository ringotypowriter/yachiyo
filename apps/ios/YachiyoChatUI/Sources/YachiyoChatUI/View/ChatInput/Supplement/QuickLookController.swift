//
//  QuickLookController.swift
//  LanguageModelChatUI
//

import Foundation
import QuickLook

class SingleItemDataSource: NSObject, @preconcurrency QLPreviewControllerDelegate, QLPreviewControllerDataSource {
    class PreviewItem: NSObject, QLPreviewItem {
        var previewItemURL: URL? {
            item
        }

        var previewItemTitle: String? {
            // The file is a temporary copy named by UUID; unnamed attachments still fall back to it.
            name.isEmpty ? item.lastPathComponent : name
        }

        let item: URL
        let name: String
        init(item: URL, name: String?) {
            self.item = item
            self.name = name ?? item.lastPathComponent
        }
    }

    private let item: PreviewItem
    private nonisolated(unsafe) var cleanup: (() -> Void)?

    required init(item: URL, name: String?, cleanup: (() -> Void)? = nil) {
        self.item = .init(item: item, name: name)
        self.cleanup = cleanup
        super.init()
    }

    func numberOfPreviewItems(in _: QLPreviewController) -> Int {
        1
    }

    func previewController(_: QLPreviewController, previewItemAt _: Int) -> any QLPreviewItem {
        item
    }

    func previewControllerDidDismiss(_: QLPreviewController) {
        cleanup?()
        cleanup = nil
    }

    deinit {
        let c = cleanup
        c?()
    }
}
