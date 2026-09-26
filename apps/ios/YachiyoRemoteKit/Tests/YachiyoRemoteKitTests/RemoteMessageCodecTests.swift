import Foundation
import XCTest
import zlib
@testable import YachiyoRemoteKit

final class RemoteMessageCodecTests: XCTestCase {
    private let codec = RemoteMessageCodec(gzip: true)
    private func json(_ size: Int) -> Data { Data(("{\"x\":\"" + String(repeating: "a", count: size - 8) + "\"}").utf8) }

    func testDecodesDesktopGzipFixture() throws {
        let fixture = try XCTUnwrap(Fixtures.json("remote-compression.json") as? [String: String])
        let raw = Data(try XCTUnwrap(fixture["raw"]).utf8)
        let encoded = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(fixture["encodedBase64"])))
        XCTAssertEqual(try codec.decode(encoded), raw)
        XCTAssertEqual(try codec.decode(codec.encode(raw)), raw)
    }

    func testThresholdAndIndependentUTF8Streams() throws {
        XCTAssertEqual(try codec.encode(json(1023)), json(1023))
        let raw = Data(("{\"text\":\"" + String(repeating: "こんにちは🌸", count: 300) + "\"}").utf8)
        let encoded = try codec.encode(raw)
        XCTAssertEqual(encoded.first, 1)
        XCTAssertLessThanOrEqual(encoded.count, raw.count - 32)
        XCTAssertEqual(try codec.decode(encoded), raw)
        XCTAssertEqual(try codec.encode(raw), encoded)
        XCTAssertEqual(try codec.encode(json(1024)).first, 1)
    }

    func testIncompressibleFallback() throws {
        // Deterministic pseudorandom bytes exercise the framing decision, independently of JSON parsing.
        var state: UInt32 = 12345
        var raw = Data([0x7b])
        for _ in 1..<1024 {
            state ^= state << 13; state ^= state >> 17; state ^= state << 5
            raw.append(UInt8(truncatingIfNeeded: state))
        }
        XCTAssertEqual(try codec.encode(raw), raw)
    }

    func testRawLimitAndLegacyFallback() throws {
        let raw = json(remoteMaxMessageBytes)
        XCTAssertEqual(try codec.decode(raw), raw)
        XCTAssertEqual(try RemoteMessageCodec.legacy.encode(raw), raw)
        XCTAssertEqual(try codec.decode(codec.encode(raw)), raw)
        XCTAssertThrowsError(try codec.encode(json(remoteMaxMessageBytes + 1)))
        XCTAssertThrowsError(try codec.decode(json(remoteMaxMessageBytes + 1)))
        XCTAssertThrowsError(try codec.decode(Data([1]) + Data(repeating: 0, count: remoteMaxMessageBytes)))
        XCTAssertThrowsError(try RemoteMessageCodec.legacy.decode(codec.encode(json(1024))))
    }

    func testMalformedGzipAndFramingRejected() throws {
        let encoded = try codec.encode(json(4096))
        var damaged = encoded
        damaged[damaged.count - 8] ^= 1 // checksum
        let invalid = [Data(), Data([0]), Data([2]), Data([2, 0]), Data(" []".utf8), Data([1]),
                       Data(encoded.dropLast()), encoded + Data([0]),
                       encoded + encoded.dropFirst(), damaged]
        for frame in invalid { XCTAssertThrowsError(try codec.decode(frame)) }
    }

    func testInflateBoundRejectsBomb() throws {
        // gzip level 1 of '{' followed by 8 MiB of 'a'.
        // Build via the SDK zlib directly to avoid bypassing the codec's outbound cap.
        let oversized = Data([0x7b]) + Data(repeating: 0x61, count: remoteMaxMessageBytes)
        let gzip = try gzipForTest(oversized)
        XCTAssertThrowsError(try codec.decode(Data([1]) + gzip)) { error in
            XCTAssertEqual(error as? RemoteMessageCodecError, .messageTooLarge)
        }
    }

    func testNegotiationAcceptsLegacyAndTypedRepliesAndFailsClosedOtherwise() throws {
        XCTAssertFalse(try RemoteHandshakeNegotiation.parse(reply: Data()).codec.gzip)
        let legacyGzip = try RemoteHandshakeNegotiation.parse(reply: Data("{\"compression\":\"gzip\"}".utf8))
        XCTAssertTrue(legacyGzip.codec.gzip)
        XCTAssertFalse(legacyGzip.codec.streamDeflate)
        XCTAssertTrue(legacyGzip.features.isEmpty)
        XCTAssertFalse(try RemoteHandshakeNegotiation.parse(reply: Data("{}".utf8)).codec.gzip)

        let hello = #"{"activeRunEnterBehavior":"enter-steers","appVersion":"1","deviceName":"Mac","epoch":"e1","protocolVersion":1,"remoteDeviceId":"desktop"}"#
        let typed = try RemoteHandshakeNegotiation.parse(reply: Data(#"{"compression":"gzip","features":["handshake-hello","stream-deflate"],"hello":\#(hello),"extra":true}"#.utf8))
        XCTAssertTrue(typed.codec.gzip)
        XCTAssertTrue(typed.codec.streamDeflate)
        XCTAssertEqual(typed.features, ["handshake-hello", "stream-deflate"])
        XCTAssertEqual(typed.hello?.epoch, "e1")
        // A hello without the feature is not trusted as the greeting.
        XCTAssertNil(try RemoteHandshakeNegotiation.parse(reply: Data(#"{"features":[],"hello":\#(hello)}"#.utf8)).hello)

        for reply in ["null", "[]", "garbage", "{\"compression\":\"brotli\"}", "{\"compression\":[\"gzip\"]}",
                      "{\"features\":[\"not-offered\"]}", "{\"features\":[\"handshake-hello\"],\"hello\":{}}"] {
            XCTAssertThrowsError(try RemoteHandshakeNegotiation.parse(reply: Data(reply.utf8)), reply)
        }
    }

    func testDecodesDesktopStreamDeflateFixtureInOrder() throws {
        let fixture = try XCTUnwrap(Fixtures.json("remote-stream-deflate.json") as? [String: [String]])
        let raw = try XCTUnwrap(fixture["raw"])
        let encoded = try XCTUnwrap(fixture["encodedBase64"]).map { try XCTUnwrap(Data(base64Encoded: $0)) }
        XCTAssertEqual(raw.count, encoded.count)
        let codec = RemoteMessageCodec(gzip: true, streamDeflate: true)
        let stream = try RemoteStreamInflater()
        for (message, frame) in zip(raw, encoded) {
            XCTAssertEqual(frame.first, 0x02)
            XCTAssertEqual(try codec.decode(frame, stream: stream), Data(message.utf8))
        }
        // Raw and gzip messages may still interleave with the stream.
        XCTAssertEqual(try codec.decode(Data(raw[0].utf8), stream: stream), Data(raw[0].utf8))
    }

    func testStreamDeflateNeedsNegotiationOrderAndAValidStream() throws {
        let fixture = try XCTUnwrap(Fixtures.json("remote-stream-deflate.json") as? [String: [String]])
        let encoded = try XCTUnwrap(fixture["encodedBase64"]).map { try XCTUnwrap(Data(base64Encoded: $0)) }
        XCTAssertThrowsError(try codec.decode(encoded[0], stream: try RemoteStreamInflater()), "not negotiated")
        let negotiated = RemoteMessageCodec(gzip: true, streamDeflate: true)
        XCTAssertThrowsError(try negotiated.decode(encoded[0]), "no stream context")
        // A later segment cannot be decoded without the earlier ones: its back references
        // point into a window this context never saw.
        XCTAssertThrowsError(try negotiated.decode(encoded[1], stream: try RemoteStreamInflater()))
        let broken = try RemoteStreamInflater()
        XCTAssertThrowsError(try negotiated.decode(Data([0x02, 0xff, 0xff, 0xff]), stream: broken))
        XCTAssertThrowsError(try negotiated.decode(encoded[0], stream: broken), "a failed context stays failed")
    }

    func testStreamDeflateBoundsEachMessage() throws {
        let deflater = TestStreamDeflater()
        let negotiated = RemoteMessageCodec(gzip: true, streamDeflate: true)
        let stream = try RemoteStreamInflater()
        let small = Data("{\"a\":1}".utf8)
        XCTAssertEqual(try negotiated.decode(deflater.encode(small), stream: stream), small)
        let bomb = deflater.encode(Data([0x7b]) + Data(repeating: 0x61, count: remoteMaxMessageBytes))
        XCTAssertLessThan(bomb.count, remoteMaxMessageBytes)
        XCTAssertThrowsError(try negotiated.decode(bomb, stream: stream)) { error in
            XCTAssertEqual(error as? RemoteMessageCodecError, .messageTooLarge)
        }
    }
}

private func gzipForTest(_ data: Data) throws -> Data {
    var stream = z_stream()
    XCTAssertEqual(deflateInit2_(&stream, 1, Z_DEFLATED, 31, 8, Z_DEFAULT_STRATEGY,
                                ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)), Z_OK)
    defer { deflateEnd(&stream) }
    var output = Data(count: Int(deflateBound(&stream, uLong(data.count))))
    let status = data.withUnsafeBytes { input in
        stream.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress)
        stream.avail_in = uInt(data.count)
        return output.withUnsafeMutableBytes { buffer in
            stream.next_out = buffer.bindMemory(to: Bytef.self).baseAddress
            stream.avail_out = uInt(buffer.count)
            return deflate(&stream, Z_FINISH)
        }
    }
    XCTAssertEqual(status, Z_STREAM_END)
    output.count = Int(stream.total_out)
    return output
}
