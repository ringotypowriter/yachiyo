import Foundation
import zlib

enum RemoteMessageCodecError: Error, Equatable {
    case unsupportedCompression
    case unsupportedFeature
    case invalidMessage
    case invalidGzip
    case invalidDeflate
    case messageTooLarge
}

/// Optional protocol features (REMOTE_FEATURES in packages/shared/src/remote/wire.ts).
public enum RemoteFeature {
    /// Message 2 carries the `remote.hello` output.
    public static let handshakeHello = "handshake-hello"
    /// Events arrive as `batch` pushes.
    public static let eventBatch = "event-batch"
    /// Desktop-to-phone messages may use the shared raw deflate stream (tag 0x02).
    public static let streamDeflate = "stream-deflate"
    /// Everything this client understands; offered in every handshake.
    public static let offered: [String] = [handshakeHello, eventBatch, streamDeflate]
}

/// What the authenticated message-2 payload selected. Old desktops answer with an empty
/// payload or exactly `{"compression":"gzip"}`; newer ones with `RemoteHandshakeServerPayload`.
struct RemoteHandshakeNegotiation: Sendable {
    let codec: RemoteMessageCodec
    let features: Set<String>
    let hello: RemoteHelloOutput?

    static let legacy = RemoteHandshakeNegotiation(codec: .legacy, features: [], hello: nil)

    /// Fails closed on anything this client did not offer: a feature it cannot decode would
    /// otherwise surface later as undecodable frames.
    static func parse(reply: Data, offered: [String] = RemoteFeature.offered) throws -> RemoteHandshakeNegotiation {
        if reply.isEmpty { return .legacy }
        guard reply.first == 0x7b, let payload = try? JSONDecoder().decode(RemoteHandshakeServerPayload.self, from: reply) else {
            throw RemoteMessageCodecError.unsupportedCompression
        }
        switch payload.compression {
        case nil, "gzip": break
        default: throw RemoteMessageCodecError.unsupportedCompression
        }
        let features = Set(payload.features ?? [])
        guard features.isSubset(of: offered) else { throw RemoteMessageCodecError.unsupportedFeature }
        return RemoteHandshakeNegotiation(
            codec: RemoteMessageCodec(gzip: payload.compression == "gzip", streamDeflate: features.contains(RemoteFeature.streamDeflate)),
            features: features,
            hello: features.contains(RemoteFeature.handshakeHello) ? payload.hello : nil
        )
    }
}

/// Application framing inside Noise authentication, never part of the handshake itself.
struct RemoteMessageCodec: Sendable {
    let gzip: Bool
    /// Inbound only: phone-to-desktop messages keep the per-message gzip tag.
    let streamDeflate: Bool
    static let legacy = RemoteMessageCodec(gzip: false)

    init(gzip: Bool, streamDeflate: Bool = false) {
        self.gzip = gzip
        self.streamDeflate = streamDeflate
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

    /// `stream` is the connection's inflate context; stream-deflate messages must be decoded
    /// through it strictly in receive order.
    func decode(_ encoded: Data, stream: RemoteStreamInflater? = nil) throws -> Data {
        guard encoded.count <= remoteMaxMessageBytes else { throw RemoteMessageCodecError.messageTooLarge }
        if encoded.first == 0x7b { return encoded }
        if encoded.first == 0x02 {
            guard streamDeflate, let stream else { throw RemoteMessageCodecError.invalidMessage }
            let raw = try stream.inflate(Data(encoded.dropFirst()), limit: remoteMaxMessageBytes)
            guard raw.first == 0x7b else { throw RemoteMessageCodecError.invalidMessage }
            return raw
        }
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

/// The phone's half of `stream-deflate`: one raw inflate context (window bits -15) for the
/// connection's lifetime. Each message is the next Z_SYNC_FLUSH segment, so a segment is only
/// decodable after every earlier one. Any error leaves the context unusable; the connection
/// closes on it anyway.
final class RemoteStreamInflater: @unchecked Sendable {
    // zlib keeps a back pointer to the z_stream, so it needs a stable address.
    private let stream = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)
    private let lock = NSLock()
    private var broken = false

    init() throws {
        stream.initialize(to: z_stream())
        guard inflateInit2_(stream, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            stream.deinitialize(count: 1)
            stream.deallocate()
            throw RemoteMessageCodecError.invalidDeflate
        }
    }

    deinit {
        inflateEnd(stream)
        stream.deinitialize(count: 1)
        stream.deallocate()
    }

    func inflate(_ segment: Data, limit: Int) throws -> Data {
        try lock.withLock {
            guard !broken else { throw RemoteMessageCodecError.invalidDeflate }
            do {
                return try inflateLocked(segment, limit: limit)
            } catch {
                broken = true
                throw error
            }
        }
    }

    private func inflateLocked(_ segment: Data, limit: Int) throws -> Data {
        guard !segment.isEmpty else { throw RemoteMessageCodecError.invalidDeflate }
        return try segment.withUnsafeBytes { source in
            stream.pointee.next_in = UnsafeMutablePointer(mutating: source.bindMemory(to: Bytef.self).baseAddress)
            stream.pointee.avail_in = uInt(segment.count)
            defer {
                stream.pointee.next_in = nil
                stream.pointee.avail_in = 0
            }
            var result = Data()
            var chunk = [UInt8](repeating: 0, count: 32 * 1024)
            while true {
                let status = chunk.withUnsafeMutableBytes { output in
                    stream.pointee.next_out = output.bindMemory(to: Bytef.self).baseAddress
                    stream.pointee.avail_out = uInt(output.count)
                    return zlib.inflate(stream, Z_SYNC_FLUSH)
                }
                let produced = chunk.count - Int(stream.pointee.avail_out)
                guard produced <= limit - result.count else { throw RemoteMessageCodecError.messageTooLarge }
                result.append(contentsOf: chunk.prefix(produced))
                // The desktop never ends the stream; an end marker means the peer broke framing.
                guard status == Z_OK || status == Z_BUF_ERROR else { throw RemoteMessageCodecError.invalidDeflate }
                // Done once all input is consumed and inflate had output space to spare.
                if stream.pointee.avail_in == 0, stream.pointee.avail_out > 0 { return result }
                // Z_BUF_ERROR with input left and a full output chunk cannot happen; without
                // progress it would loop forever.
                guard status == Z_OK || produced > 0 else { throw RemoteMessageCodecError.invalidDeflate }
            }
        }
    }
}
