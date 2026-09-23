import Foundation
import XCTest
@testable import YachiyoRemoteKit

/// Runs against scripts/remote-dev-harness.ts when YACHIYO_REMOTE_PAIRING_URL is set:
///   node --experimental-strip-types scripts/remote-dev-harness.ts --empty --url-file /tmp/pair.txt
///   YACHIYO_REMOTE_PAIRING_URL=$(cat /tmp/pair.txt) swift test --filter HarnessIntegrationTests
final class HarnessIntegrationTests: XCTestCase {
    func testPairsStreamsAndResumesAgainstTheFakeDesktop() async throws {
        guard let raw = ProcessInfo.processInfo.environment["YACHIYO_REMOTE_PAIRING_URL"],
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines))
        else { throw XCTSkip("Set YACHIYO_REMOTE_PAIRING_URL to a harness pairing URL.") }

        let identity = RemoteClientIdentity(staticPrivateKey: NoiseKeyPair.generatePrivateKey(), deviceName: "Swift Test", appVersion: "1")
        let connector = DesktopConnector(identity: identity)
        let payload = try PairingURL.decode(url)
        let (client, desktop, hello) = try await connector.pair(payload)
        XCTAssertTrue(client.codec.gzip)
        XCTAssertEqual(hello.protocolVersion, 1)
        XCTAssertFalse(desktop.pairingId.isEmpty)

        let created: RemoteThreadsCreateOutput = try await client.call("threads.create", EmptyInput())
        var tracker = EventCursorTracker()
        _ = tracker.accept(try await client.call("events.subscribe", tracker.subscribeInput(threadIds: [created.thread.id])))

        let accepted: RemoteChatAccepted = try await client.call(
            "chat.send",
            ["threadId": created.thread.id, "content": "ask: ship from swift?"]
        )
        var question: RemoteToolCall?
        for await push in client.pushes {
            guard case let .apply(event) = tracker.observe(push) else { continue }
            if event.type == .toolUpdated, event.toolCall?.status == .waitingForUser {
                question = event.toolCall
                break
            }
        }
        let toolCall = try XCTUnwrap(question)
        XCTAssertEqual(toolCall.question?.question, "ship from swift?")
        let _: RemoteOk = try await client.call(
            "run.answerToolQuestion",
            ["threadId": created.thread.id, "runId": accepted.runId, "toolCallId": toolCall.id, "answer": "Yes"]
        )
        client.close()

        // Reconnect with Noise_IK and resume from the last applied event.
        var stored = desktop
        stored.cursor = tracker.cursor
        let (reconnected, _) = try await connector.connect(stored)
        XCTAssertTrue(reconnected.codec.gzip)
        var resumedTracker = EventCursorTracker(cursor: stored.cursor)
        let resumed = resumedTracker.accept(try await reconnected.call("events.subscribe", resumedTracker.subscribeInput(threadIds: [created.thread.id])))
        XCTAssertFalse(resumed, "resume within the buffer should not need a resync")
        var completed = false
        for await push in reconnected.pushes {
            guard case let .apply(event) = resumedTracker.observe(push) else { continue }
            if event.type == .runStatus, event.runId == accepted.runId, event.status == .completed {
                completed = true
                break
            }
        }
        XCTAssertTrue(completed)
        let detail: RemoteThreadDetail = try await reconnected.call("threads.load", ["threadId": created.thread.id])
        XCTAssertTrue(detail.messages.last?.content.contains("You answered: Yes") ?? false)
        // Exercise compression in both directions with non-ASCII content over a real socket.
        let largeContent = String(repeating: "Swift gzip 相互運用 🌸", count: 1000)
        let largeAccepted: RemoteChatAccepted = try await reconnected.call(
            "chat.send", ["threadId": created.thread.id, "content": largeContent]
        )
        XCTAssertFalse(largeAccepted.runId.isEmpty)
        let largeDetail: RemoteThreadDetail = try await reconnected.call("threads.load", ["threadId": created.thread.id])
        XCTAssertTrue(largeDetail.messages.contains { $0.content == largeContent })
        reconnected.close()
    }
}

struct EmptyInput: Encodable {}
