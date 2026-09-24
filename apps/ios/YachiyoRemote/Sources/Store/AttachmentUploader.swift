import CryptoKit
import Foundation
import YachiyoChatUI
import YachiyoRemoteKit

/// Uploads composer attachments in 512 KB chunks (`attachments.begin/chunk/commit`) and returns
/// the attachment ids `chat.send` references.
enum AttachmentUploader {
    static let chunkSize = 512 * 1024

    @MainActor
    static func upload(_ attachments: [ChatInputAttachment], to desktopId: String) async throws -> [String] {
        var ids: [String] = []
        for attachment in attachments {
            let (data, mediaType, filename) = try await payload(for: attachment)
            let begun: RemoteAttachmentsBeginOutput = try await RemoteStore.shared.call(desktopId, "attachments.begin", BeginInput(filename: filename, mediaType: mediaType, size: data.count))
            var index = 0
            var offset = 0
            while offset < data.count {
                let end = min(offset + chunkSize, data.count)
                let range = offset ..< end
                // Prepare only the chunk about to be sent, away from the main actor.
                let encoded = try await prepare {
                    try Task.checkCancellation()
                    return data.subdata(in: range).base64EncodedString()
                }
                try Task.checkCancellation()
                let _: RemoteAttachmentsChunkOutput = try await RemoteStore.shared.call(desktopId, "attachments.chunk", ChunkInput(
                    uploadId: begun.uploadId,
                    index: index,
                    data: encoded
                ))
                offset = end
                index += 1
            }
            let digest = try await prepare {
                try Task.checkCancellation()
                return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            }
            try Task.checkCancellation()
            let committed: RemoteAttachmentsCommitOutput = try await RemoteStore.shared.call(desktopId, "attachments.commit", CommitInput(uploadId: begun.uploadId, sha256: digest))
            ids.append(committed.attachmentId)
        }
        return ids
    }

    private static func payload(for attachment: ChatInputAttachment) async throws -> (Data, String, String) {
        switch attachment.type {
        case .image:
            let name = attachment.storageFilename.isEmpty ? "image.jpeg" : attachment.storageFilename
            return (attachment.fileData, "image/jpeg", name)
        case .document, .audio:
            let name = attachment.storageFilename.isEmpty ? "\(attachment.name).txt" : attachment.storageFilename
            let text = attachment.textContent
            let data = try await prepare {
                try Task.checkCancellation()
                return Data(text.utf8)
            }
            try Task.checkCancellation()
            return (data, "text/plain", name.hasSuffix(".txt") ? name : "\(name).txt")
        }
    }

    private static func prepare<T: Sendable>(_ operation: @escaping @Sendable () throws -> T) async throws -> T {
        let work = Task.detached(priority: .userInitiated, operation: operation)
        return try await withTaskCancellationHandler {
            try await work.value
        } onCancel: {
            work.cancel()
        }
    }

    private struct BeginInput: Encodable { let filename: String; let mediaType: String; let size: Int }
    private struct ChunkInput: Encodable { let uploadId: String; let index: Int; let data: String }
    private struct CommitInput: Encodable { let uploadId: String; let sha256: String }
}
