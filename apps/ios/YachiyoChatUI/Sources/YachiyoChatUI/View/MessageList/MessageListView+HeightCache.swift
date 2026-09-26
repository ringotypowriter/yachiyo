//
//  MessageListView+HeightCache.swift
//  YachiyoChatUI
//
//  ListViewKit forgets every row height when the width changes or a row moves. This cache keeps
//  measured content heights per row across those rebuilds, keyed by what the row renders, the
//  width and the Dynamic Type size, so rotating back or reordering never re-measures.
//

import UIKit

extension MessageListView {
    @MainActor
    final class RowHeightCache {
        private struct Record {
            let identity: Entry
            let width: CGFloat
            let category: UIContentSizeCategory
            let height: CGFloat
        }

        /// Enough for portrait, landscape and one Split View width per row.
        private static let recordsPerRow = 3
        private var records: [String: [Record]] = [:]

        var count: Int { records.count }

        func height(for entry: Entry, width: CGFloat, category: UIContentSizeCategory) -> CGFloat? {
            let identity = entry.measurementIdentity
            return records[entry.id]?.first {
                $0.width == width && $0.category == category && $0.identity == identity
            }?.height
        }

        func store(_ height: CGFloat, for entry: Entry, width: CGFloat, category: UIContentSizeCategory) {
            let identity = entry.measurementIdentity
            var rowRecords = records[entry.id] ?? []
            // Content changes supersede every width; widths of the same content accumulate.
            rowRecords.removeAll { $0.identity != identity || ($0.width == width && $0.category == category) }
            rowRecords.append(Record(identity: identity, width: width, category: category, height: height))
            if rowRecords.count > Self.recordsPerRow { rowRecords.removeFirst(rowRecords.count - Self.recordsPerRow) }
            records[entry.id] = rowRecords
        }

        func prune(keeping ids: Set<String>) {
            records = records.filter { ids.contains($0.key) }
        }

        func removeAll() {
            records.removeAll()
        }
    }
}

extension MessageListView.Entry {
    /// The entry without layout-only data, i.e. exactly what determines the content height.
    var measurementIdentity: Self {
        guard case .responseContent(let id, var chunk) = self else { return self }
        chunk.spacingAfter = nil
        return .responseContent(id, chunk)
    }
}
