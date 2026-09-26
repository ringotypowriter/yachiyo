import Foundation
import Security
import XCTest
@testable import YachiyoRemoteKit

final class RemoteIdentityProviderTests: XCTestCase {
    @MainActor
    func testTheKeyLoadsOffTheMainThreadOnceAndRetriesAfterAFailure() async throws {
        let loads = LoadLog()
        let key = NoiseKeyPair.generatePrivateKey()
        let provider = RemoteIdentityProvider(deviceName: "Phone", appVersion: "2") {
            try loads.load(key)
        }
        do {
            _ = try await provider.identity()
            XCTFail("the first load fails")
        } catch {}
        let identity = try await provider.identity()
        _ = try await provider.identity()
        XCTAssertEqual(identity.staticPrivateKey, key)
        XCTAssertEqual(identity.deviceName, "Phone")
        XCTAssertEqual(loads.count, 2, "a failure is retried, a success is cached")
        XCTAssertFalse(loads.sawMainThread)
    }
}

private final class LoadLog: @unchecked Sendable {
    private let lock = NSLock()
    private var loads = 0
    private var mainThread = false
    var count: Int { lock.withLock { loads } }
    var sawMainThread: Bool { lock.withLock { mainThread } }

    func load(_ key: Data) throws -> Data {
        let attempt = lock.withLock {
            loads += 1
            if Thread.isMainThread { mainThread = true }
            return loads
        }
        if attempt == 1 { throw KeychainError.status(errSecInteractionNotAllowed) }
        return key
    }
}
