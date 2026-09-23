import Foundation
import zlib

enum RemoteMessageCodecError: Error, Equatable {
    case unsupportedCompression
    case invalidMessage
    case invalidGzip
    case messageTooLarge
}

/// Application framing inside Noise authentication, never part of the handshake itself.
struct RemoteMessageCodec: Sendable {
    let gzip: Bool
    static let legacy = RemoteMessageCodec(gzip: false)

    static func negotiated(reply: Data) throws -> RemoteMessageCodec {
        if reply.isEmpty { return .legacy }
        guard let object = try? JSONSerialization.jsonObject(with: reply) as? [String: Any],
              object.count == 1, object["compression"] as? String == "gzip"
        else { throw RemoteMessageCodecError.unsupportedCompression }
        return RemoteMessageCodec(gzip: true)
    }

    func encode(_ raw: Data) throws -> Data {
        guard raw.count <= remoteMaxMessageBytes else { throw RemoteMessageCodecError.messageTooLarge }
        guard raw.first == 0x7b else { throw RemoteMessageCodecError.invalidMessage }
        guard gzip, raw.count >= 1024 else { return raw }
        let compressed = try Self.transform(raw, compress: true, limit: remoteMaxMessageBytes)
        // Compression is optional: an incompressible stream exceeding the cap falls back to raw.
        guard let compressed, compressed.count + 1 <= raw.count - 32 else { return raw }
        return Data([0x01]) + compressed
    }

    func decode(_ encoded: Data) throws -> Data {
        guard encoded.count <= remoteMaxMessageBytes else { throw RemoteMessageCodecError.messageTooLarge }
        if encoded.first == 0x7b { return encoded }
        guard gzip, encoded.first == 0x01 else { throw RemoteMessageCodecError.invalidMessage }
        guard let raw = try Self.transform(Data(encoded.dropFirst()), compress: false, limit: remoteMaxMessageBytes),
              raw.first == 0x7b else { throw RemoteMessageCodecError.invalidMessage }
        return raw
    }

    /// Fresh gzip stream per message. Inflate stops at the first member and rejects any unused
    /// input, including another member or padding. Output is bounded before appending each chunk.
    private static func transform(_ input: Data, compress: Bool, limit: Int) throws -> Data? {
        var stream = z_stream()
        let initialized = compress
            ? deflateInit2_(&stream, 1, Z_DEFLATED, 31, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
            : inflateInit2_(&stream, 31, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard initialized == Z_OK else { throw RemoteMessageCodecError.invalidGzip }
        defer {
            if compress { deflateEnd(&stream) } else { inflateEnd(&stream) }
        }
        return try input.withUnsafeBytes { source in
            stream.next_in = UnsafeMutablePointer(mutating: source.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(input.count)
            var result = Data()
            var chunk = [UInt8](repeating: 0, count: 32 * 1024)
            while true {
                let status = chunk.withUnsafeMutableBytes { output in
                    stream.next_out = output.bindMemory(to: Bytef.self).baseAddress
                    stream.avail_out = uInt(output.count)
                    return compress ? deflate(&stream, Z_FINISH) : inflate(&stream, Z_NO_FLUSH)
                }
                let produced = chunk.count - Int(stream.avail_out)
                guard produced <= limit - result.count else {
                    if compress { return nil }
                    throw RemoteMessageCodecError.messageTooLarge
                }
                result.append(contentsOf: chunk.prefix(produced))
                if status == Z_STREAM_END {
                    guard stream.avail_in == 0 else { throw RemoteMessageCodecError.invalidGzip }
                    return result
                }
                guard status == Z_OK, produced > 0 else { throw RemoteMessageCodecError.invalidGzip }
            }
        }
    }
}
