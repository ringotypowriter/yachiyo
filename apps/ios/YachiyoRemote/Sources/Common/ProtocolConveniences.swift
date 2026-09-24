import Foundation
import YachiyoRemoteKit

extension RemoteThreadSummary {
    func with(latestRun: LatestRun?) -> RemoteThreadSummary {
        RemoteThreadSummary(
            capabilities: capabilities, colorTag: colorTag, icon: icon, id: id, latestRun: latestRun,
            needsAttention: needsAttention, preview: preview, privacyMode: privacyMode, starred: starred,
            syncOriginDeviceId: syncOriginDeviceId, title: title, updatedAt: updatedAt,
            workspaceName: workspaceName, workspacePath: workspacePath
        )
    }

    func with(starred: Bool) -> RemoteThreadSummary {
        RemoteThreadSummary(
            capabilities: capabilities, colorTag: colorTag, icon: icon, id: id, latestRun: latestRun,
            needsAttention: needsAttention, preview: preview, privacyMode: privacyMode, starred: starred,
            syncOriginDeviceId: syncOriginDeviceId, title: title, updatedAt: updatedAt,
            workspaceName: workspaceName, workspacePath: workspacePath
        )
    }

    var isRunning: Bool { latestRun?.status == .running }
    var isReadOnly: Bool { !capabilities.canSend }
    var updatedDate: Date { ISO8601.parse(updatedAt) ?? .distantPast }
}

extension String {
    var isoDate: Date? { ISO8601.parse(self) }
}
