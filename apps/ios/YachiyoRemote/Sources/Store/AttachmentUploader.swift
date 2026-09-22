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
            let (data, mediaType, filename) = payload(for: attachment)
            let begun: RemoteAttachmentsBeginOutput = try await RemoteStore.shared.call(desktopId, "attachments.begin", BeginInput(filename: filename, mediaType: mediaType, size: data.count))
            var index = 0
            var offset = 0
            while offset < data.count {
                let end = min(offset + chunkSize, data.count)
                let _: RemoteAttachmentsChunkOutput = try await RemoteStore.shared.call(desktopId, "attachments.chunk", ChunkInput(
                    uploadId: begun.uploadId,
                    index: index,
                    data: data.subdata(in: offset ..< end).base64EncodedString()
                ))
                offset = end
                index += 1
            }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let committed: RemoteAttachmentsCommitOutput = try await RemoteStore.shared.call(desktopId, "attachments.commit", CommitInput(uploadId: begun.uploadId, sha256: digest))
            ids.append(committed.attachmentId)
        }
        return ids
    }

    private static func payload(for attachment: ChatInputAttachment) -> (Data, String, String) {
        switch attachment.type {
        case .image:
            let name = attachment.storageFilename.isEmpty ? "image.jpeg" : attachment.storageFilename
            return (attachment.fileData, "image/jpeg", name)
        case .document, .audio:
            let name = attachment.storageFilename.isEmpty ? "\(attachment.name).txt" : attachment.storageFilename
            return (Data(attachment.textContent.utf8), "text/plain", name.hasSuffix(".txt") ? name : "\(name).txt")
        }
    }

    private struct BeginInput: Encodable { let filename: String; let mediaType: String; let size: Int }
    private struct ChunkInput: Encodable { let uploadId: String; let index: Int; let data: String }
    private struct CommitInput: Encodable { let uploadId: String; let sha256: String }
}
