import Foundation
import XCTest
@testable import YachiyoRemoteKit

final class NoiseTests: XCTestCase {
    func testCacophonyVectorsForTheInitiator() throws {
        let file = try Fixtures.json("noise-cacophony-vectors.json") as! [String: Any]
        let vectors = file["vectors"] as! [[String: Any]]
        XCTAssertEqual(vectors.count, 2)
        for vector in vectors {
            let name = vector["protocol_name"] as! String
            let pattern: NoisePattern = name.contains("psk2") ? .ikpsk2 : .ik
            let psk = (vector["init_psks"] as? [String])?.first.map { Data(hex: $0) }
            let initiator = try NoiseInitiator(
                pattern: pattern,
                prologue: Data(hex: vector["init_prologue"] as! String),
                staticPrivateKey: Data(hex: vector["init_static"] as! String),
                remoteStaticKey: Data(hex: vector["init_remote_static"] as! String),
                psk: psk,
                ephemeralPrivateKey: Data(hex: vector["init_ephemeral"] as! String)
            )
            let messages = vector["messages"] as! [[String: String]]
            let message1 = try initiator.writeMessage1(payload: Data(hex: messages[0]["payload"]!))
            XCTAssertEqual(message1.hex, messages[0]["ciphertext"], name)
            let payload2 = try initiator.readMessage2(Data(hex: messages[1]["ciphertext"]!))
            XCTAssertEqual(payload2.hex, messages[1]["payload"], name)
            XCTAssertEqual(initiator.handshakeHash.hex, vector["handshake_hash"] as? String, name)

            let transport = try initiator.split()
            for (index, message) in messages.dropFirst(2).enumerated() {
                if index % 2 == 0 {
                    XCTAssertEqual(try transport.encrypt(Data(hex: message["payload"]!)).hex, message["ciphertext"], name)
                } else {
                    XCTAssertEqual(try transport.decrypt(Data(hex: message["ciphertext"]!)).hex, message["payload"], name)
                }
            }
        }
    }

    func testCrossLanguageSessionsProducedByTheDesktop() throws {
        let sessions = try Fixtures.json("noise-sessions.json") as! [[String: Any]]
        XCTAssertEqual(sessions.count, 2)
        for session in sessions {
            let pattern: NoisePattern = (session["pattern"] as! String) == "IKpsk2" ? .ikpsk2 : .ik
            let initiator = try NoiseInitiator(
                pattern: pattern,
                prologue: Data(hex: session["prologue"] as! String),
                staticPrivateKey: Data(hex: session["phoneStaticPrivate"] as! String),
                remoteStaticKey: Data(hex: session["desktopStaticPublic"] as! String),
                psk: (session["psk"] as? String).map { Data(hex: $0) },
                ephemeralPrivateKey: Data(hex: session["phoneEphemeralPrivate"] as! String)
            )
            XCTAssertEqual(
                try NoiseKeyPair.publicKey(forPrivate: Data(hex: session["phoneStaticPrivate"] as! String)).hex,
                session["phoneStaticPublic"] as? String
            )
            let message1 = try initiator.writeMessage1(payload: Data(hex: session["message1Payload"] as! String))
            XCTAssertEqual(message1.hex, session["message1"] as? String)
            let payload2 = try initiator.readMessage2(Data(hex: session["message2"] as! String))
            XCTAssertEqual(payload2.hex, session["message2Payload"] as? String)
            XCTAssertEqual(initiator.handshakeHash.hex, session["handshakeHash"] as? String)

            let transport = try initiator.split()
            for frame in session["transport"] as! [[String: String]] {
                if frame["from"] == "phone" {
                    XCTAssertEqual(try transport.encrypt(Data(hex: frame["plaintext"]!)).hex, frame["ciphertext"])
                } else {
                    XCTAssertEqual(try transport.decrypt(Data(hex: frame["ciphertext"]!)).hex, frame["plaintext"])
                }
            }
        }
    }

    func testTransportClosesAfterATamperedOrReplayedFrame() throws {
        let session = (try Fixtures.json("noise-sessions.json") as! [[String: Any]])[0]
        func connected() throws -> NoiseTransport {
            let initiator = try NoiseInitiator(
                pattern: .ik,
                prologue: Data(hex: session["prologue"] as! String),
                staticPrivateKey: Data(hex: session["phoneStaticPrivate"] as! String),
                remoteStaticKey: Data(hex: session["desktopStaticPublic"] as! String),
                ephemeralPrivateKey: Data(hex: session["phoneEphemeralPrivate"] as! String)
            )
            _ = try initiator.writeMessage1(payload: Data(hex: session["message1Payload"] as! String))
            _ = try initiator.readMessage2(Data(hex: session["message2"] as! String))
            return try initiator.split()
        }
        let desktopFrames = (session["transport"] as! [[String: String]]).filter { $0["from"] == "desktop" }

        let tampered = try connected()
        var frame = Data(hex: desktopFrames[0]["ciphertext"]!)
        frame[frame.count - 1] ^= 0x01
        XCTAssertThrowsError(try tampered.decrypt(frame))
        XCTAssertThrowsError(try tampered.decrypt(Data(hex: desktopFrames[0]["ciphertext"]!))) { error in
            XCTAssertEqual(error as? NoiseError, .channelClosed)
        }

        let replayed = try connected()
        _ = try replayed.decrypt(Data(hex: desktopFrames[0]["ciphertext"]!))
        XCTAssertThrowsError(try replayed.decrypt(Data(hex: desktopFrames[0]["ciphertext"]!)))
    }

    func testPairingHandshakeFailsWithTheWrongToken() throws {
        let session = (try Fixtures.json("noise-sessions.json") as! [[String: Any]])[1]
        let initiator = try NoiseInitiator(
            pattern: .ikpsk2,
            prologue: Data(hex: session["prologue"] as! String),
            staticPrivateKey: Data(hex: session["phoneStaticPrivate"] as! String),
            remoteStaticKey: Data(hex: session["desktopStaticPublic"] as! String),
            psk: Data(repeating: 1, count: 32),
            ephemeralPrivateKey: Data(hex: session["phoneEphemeralPrivate"] as! String)
        )
        _ = try initiator.writeMessage1(payload: Data(hex: session["message1Payload"] as! String))
        XCTAssertThrowsError(try initiator.readMessage2(Data(hex: session["message2"] as! String)))
    }
}
