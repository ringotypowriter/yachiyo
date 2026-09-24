import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class PairingURLTests: XCTestCase {
    private func url(expiresAt: String = "2099-01-01T00:00:00.000Z", key: String = String(repeating: "A", count: 43)) -> URL {
        let payload = """
        {"v":1,"remoteDeviceId":"0123456789abcdef0123456789abcdef","deviceName":"Studio Mac",
         "desktopKey":"\(key)","token":"\(String(repeating: "B", count: 43))",
         "endpoints":[{"kind":"tunnel","url":"wss://quiet-fox.trycloudflare.com/remote/v1"}],
         "expiresAt":"\(expiresAt)"}
        """
        return URL(string: "yachiyo-remote://pair?v=1&d=\(Base64URL.encode(Data(payload.utf8)))")!
    }

    func testDecodesTheQRCodePayload() throws {
        let payload = try PairingURL.decode(url())
        XCTAssertEqual(payload.deviceName, "Studio Mac")
        XCTAssertEqual(payload.endpoints.first?.kind, .tunnel)
    }

    func testLeavesExpiryToTheMacSoClockSkewCannotRejectAFreshCode() throws {
        XCTAssertNoThrow(try PairingURL.decode(url(expiresAt: "2020-01-01T00:00:00.000Z")))
    }

    func testParsesThreadDatesWithAndWithoutFractionalSeconds() {
        let fractional = ISO8601.parse("2026-09-24T13:06:20.265Z")
        let standard = ISO8601.parse("2026-09-24T13:06:20Z")
        guard let fractional, let standard else { return XCTFail("Both timestamp formats must parse") }
        XCTAssertEqual(fractional.timeIntervalSince(standard), 0.265, accuracy: 0.001)
    }

    func testRejectsMalformedAndForeignURLs() {
        XCTAssertThrowsError(try PairingURL.decode(url(key: "short"))) {
            XCTAssertEqual($0 as? PairingURLError, .malformedPayload)
        }
        XCTAssertThrowsError(try PairingURL.decode(URL(string: "https://example.com/pair?v=1&d=x")!)) {
            XCTAssertEqual($0 as? PairingURLError, .notAPairingURL)
        }
        XCTAssertThrowsError(try PairingURL.decode(URL(string: "yachiyo-remote://pair?v=2&d=x")!)) {
            XCTAssertEqual($0 as? PairingURLError, .unsupportedVersion)
        }
    }
}
