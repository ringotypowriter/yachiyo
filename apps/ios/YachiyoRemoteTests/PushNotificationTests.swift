import XCTest
import UserNotifications
@testable import Yachiyo

final class PushNotificationTests: XCTestCase {
    func testPermissionEntryRequestsOnlyUndeterminedAuthorization() {
        XCTAssertEqual(NotificationPermissionAction(status: .notDetermined), .request)
        XCTAssertEqual(NotificationPermissionAction(status: .denied), .openSettings)
        XCTAssertEqual(NotificationPermissionAction(status: .authorized), .openSettings)
        XCTAssertEqual(NotificationPermissionAction(status: .provisional), .openSettings)
        XCTAssertEqual(NotificationPermissionAction(status: .ephemeral), .openSettings)
    }

    func testDeniedRegistrationEncodesExplicitNull() throws {
        let json = try JSONEncoder().encode(PushRegisterInput(token: nil))
        XCTAssertEqual(String(decoding: json, as: UTF8.self), "{\"token\":null}")
    }

    func testRegistrationIsSentOncePerConnectionAndAgainOnReconnectOrTokenChange() {
        var plan = PushRegistrationPlan()
        let connection = UUID()
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: connection, token: .value(String(repeating: "a", count: 64))))
        XCTAssertFalse(plan.begin(desktopId: "mac", connection: connection, token: .value(String(repeating: "a", count: 64))))
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: connection, token: .value(String(repeating: "b", count: 64))))
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: UUID(), token: .value(String(repeating: "b", count: 64))))
    }

    func testDeniedPermissionSendsNullButUnknownPermissionDoesNotSend() {
        var plan = PushRegistrationPlan()
        let connection = UUID()
        XCTAssertFalse(plan.begin(desktopId: "mac", connection: connection, token: .unknown))
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: connection, token: .denied))
        XCTAssertFalse(plan.begin(desktopId: "mac", connection: connection, token: .denied))
    }

    func testUnsupportedDesktopDoesNotRetryUntilAReconnect() {
        var plan = PushRegistrationPlan()
        let connection = UUID()
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: connection, token: .denied))
        plan.unsupported(desktopId: "mac", connection: connection)
        XCTAssertFalse(plan.begin(desktopId: "mac", connection: connection, token: .value(String(repeating: "a", count: 64))))
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: UUID(), token: .denied))
    }

    func testReconnectRetriesAnUnchangedTokenAfterPreviousAttempt() {
        var plan = PushRegistrationPlan()
        let token = PushToken.value(String(repeating: "c", count: 64))
        let firstSocket = UUID()
        let reconnectedSocket = UUID()
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: firstSocket, token: token))
        XCTAssertFalse(plan.begin(desktopId: "mac", connection: firstSocket, token: token))
        XCTAssertTrue(plan.begin(desktopId: "mac", connection: reconnectedSocket, token: token))
    }

    func testRouteRejectsMalformedAndUnpairedPayload() {
        let paired: Set<String> = ["paired"]
        XCTAssertNil(NotificationThreadRoute(userInfo: ["threadId": "thread", "remoteDeviceId": "stranger"], pairedDesktopIds: paired))
        XCTAssertNil(NotificationThreadRoute(userInfo: ["threadId": "", "remoteDeviceId": "paired"], pairedDesktopIds: paired))
        XCTAssertNil(NotificationThreadRoute(userInfo: ["threadId": 123, "remoteDeviceId": "paired"], pairedDesktopIds: paired))
        XCTAssertNil(NotificationThreadRoute(userInfo: ["threadId": "thread"], pairedDesktopIds: paired))
        XCTAssertEqual(NotificationThreadRoute(userInfo: ["threadId": "thread", "remoteDeviceId": "paired"], pairedDesktopIds: paired), .init(desktopId: "paired", threadId: "thread"))
    }
}
