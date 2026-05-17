import Foundation
import Vision

struct OcrLine: Codable {
    let text: String
    let confidence: Float
}

struct OcrResult: Codable {
    let schemaVersion: Int
    let engine: String
    let imagePath: String
    let revision: Int
    let recognitionLevel: String
    let languageMode: String
    let requestedLanguages: [String]
    let systemPreferredLanguages: [String]
    let languages: [String]
    let lines: [OcrLine]

    init(
        imagePath: String,
        revision: Int,
        recognitionLevel: String,
        languageMode: String,
        requestedLanguages: [String],
        systemPreferredLanguages: [String],
        languages: [String],
        lines: [OcrLine]
    ) {
        self.schemaVersion = 1
        self.engine = "apple-vision"
        self.imagePath = imagePath
        self.revision = revision
        self.recognitionLevel = recognitionLevel
        self.languageMode = languageMode
        self.requestedLanguages = requestedLanguages
        self.systemPreferredLanguages = systemPreferredLanguages
        self.languages = languages
        self.lines = lines
    }

    var text: String {
        lines.map(\.text).joined(separator: "\n")
    }
}

struct OcrLanguagesResult: Codable {
    let schemaVersion: Int
    let engine: String
    let revision: Int
    let recognitionLevel: String
    let supportedLanguages: [String]
    let systemPreferredLanguages: [String]

    init(
        revision: Int,
        recognitionLevel: String,
        supportedLanguages: [String],
        systemPreferredLanguages: [String]
    ) {
        self.schemaVersion = 1
        self.engine = "apple-vision"
        self.revision = revision
        self.recognitionLevel = recognitionLevel
        self.supportedLanguages = supportedLanguages
        self.systemPreferredLanguages = systemPreferredLanguages
    }
}

extension VNRecognizedTextObservation {
    func ocrLine() -> OcrLine? {
        guard let candidate = topCandidates(1).first else { return nil }

        return OcrLine(text: candidate.string, confidence: candidate.confidence)
    }
}
