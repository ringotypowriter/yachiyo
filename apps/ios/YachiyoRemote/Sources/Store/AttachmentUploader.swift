import CryptoKit
import Foundation
import YachiyoChatUI
import YachiyoRemoteKit

/// Uploads composer attachments in chunks (`attachments.begin/chunk/commit`) and returns the
/// attachment ids `chat.send` references. Up to the desktop's `maxInFlightChunks` chunk calls
/// are pipelined; at most that many encoded chunks (plus the one being prepared) are in memory.
enum AttachmentUploader {
    /// Bytes acknowledged by the desktop so far, and the total across all attachments.
    typealias Progress = @MainActor (_ sent: Int, _ total: Int) -> Void

    @MainActor
    static func upload(_ attachments: [ChatInputAttachment], to desktopId: String, progress: Progress? = nil) async throws -> [String] {
        var payloads: [(Data, String, String)] = []
        for attachment in attachments { payloads.append(try await payload(for: attachment)) }
        let total = payloads.reduce(0) { $0 + $1.0.count }
        var sent = 0
        progress?(0, total)
        var ids: [String] = []
        for (data, mediaType, filename) in payloads {
            let begun: RemoteAttachmentsBeginOutput = try await RemoteStore.shared.call(desktopId, "attachments.begin", BeginInput(filename: filename, mediaType: mediaType, size: data.count))
            guard begun.chunkSize > 0 else { throw RemoteCallError(name: "RemoteValidationError", message: "Invalid upload chunk size.") }
            let window = max(1, begun.maxInFlightChunks ?? 1)
            let reader = ChunkReader(data: data, chunkSize: begun.chunkSize)
            var inFlight: [(call: RemotePendingCall<RemoteAttachmentsChunkOutput>, bytes: Int)] = []
            // An abandoned upload must not leave its queued chunks waiting on the socket.
            defer { for entry in inFlight { entry.call.cancel() } }
            while let chunk = try await prepare({
                try Task.checkCancellation()
                return reader.next()
            }) {
                try Task.checkCancellation()
                if inFlight.count >= window {
                    let oldest = inFlight.removeFirst()
                    _ = try await oldest.call.value()
                    sent += oldest.bytes
                    progress?(sent, total)
                }
                guard let link = RemoteStore.shared.link(for: desktopId) else {
                    throw RemoteCallError(name: "RemoteOffline", message: "Unknown device.")
                }
                // Queued synchronously, so chunks reach the desktop in index order.
                let call = try link.startCall("attachments.chunk", ChunkInput(uploadId: begun.uploadId, index: chunk.index, data: chunk.base64), as: RemoteAttachmentsChunkOutput.self)
                inFlight.append((call, chunk.bytes))
            }
            while !inFlight.isEmpty {
                let oldest = inFlight.removeFirst()
                _ = try await oldest.call.value()
                sent += oldest.bytes
                progress?(sent, total)
            }
            try Task.checkCancellation()
            let digest = reader.digest()
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

    private struct Chunk: Sendable { let index: Int; let base64: String; let bytes: Int }

    /// Slices, encodes and hashes the file in one pass. `next()` runs off the main actor, one
    /// call at a time (each is awaited before the next starts).
    private final class ChunkReader: @unchecked Sendable {
        private let data: Data
        private let chunkSize: Int
        private var offset = 0
        private var index = 0
        private var hasher = SHA256()

        init(data: Data, chunkSize: Int) {
            self.data = data
            self.chunkSize = chunkSize
        }

        func next() -> Chunk? {
            guard offset < data.count else { return nil }
            let end = min(offset + chunkSize, data.count)
            let slice = data.subdata(in: offset ..< end)
            hasher.update(data: slice)
            defer {
                offset = end
                index += 1
            }
            return Chunk(index: index, base64: slice.base64EncodedString(), bytes: slice.count)
        }

        func digest() -> String {
            hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }
    }

    private struct BeginInput: Encodable { let filename: String; let mediaType: String; let size: Int }
    private struct ChunkInput: Encodable { let uploadId: String; let index: Int; let data: String }
    private struct CommitInput: Encodable { let uploadId: String; let sha256: String }
}
