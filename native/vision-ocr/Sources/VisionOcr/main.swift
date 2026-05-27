import AppKit
import Foundation
import Vision

func loadCGImage(at path: String) -> CGImage? {
    NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
}

func writeJson<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    let options = try parseCliOptions(Array(CommandLine.arguments.dropFirst()))

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = options.recognitionLevel.visionLevel
    request.usesLanguageCorrection = true
    request.revision = VNRecognizeTextRequestRevision3

    let supportedLanguages = try request.supportedRecognitionLanguages()
    let systemPreferredLanguages = Locale.preferredLanguages

    if options.command == .listLanguages {
        try writeJson(
            OcrLanguagesResult(
                revision: request.revision,
                recognitionLevel: options.recognitionLevel.rawValue,
                supportedLanguages: supportedLanguages,
                systemPreferredLanguages: systemPreferredLanguages
            )
        )
        exit(0)
    }

    guard let imagePath = options.imagePath else {
        throw CliOptionsError.missingImagePath
    }
    guard let image = loadCGImage(at: imagePath) else {
        fputs("Could not load image: \(imagePath)\n", stderr)
        exit(1)
    }

    let languages = try resolveRecognitionLanguages(
        options: options,
        supportedLanguages: supportedLanguages,
        systemPreferredLanguages: systemPreferredLanguages
    )

    request.automaticallyDetectsLanguage = options.languageMode == .automatic ||
        (options.languageMode == .system && languages.isEmpty)
    if !languages.isEmpty {
        request.recognitionLanguages = languages
    }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let lines = (request.results ?? []).compactMap { $0.ocrLine() }
    try writeJson(
        OcrResult(
            imagePath: imagePath,
            revision: request.revision,
            recognitionLevel: options.recognitionLevel.rawValue,
            languageMode: options.languageMode.rawValue,
            requestedLanguages: options.requestedLanguages,
            systemPreferredLanguages: systemPreferredLanguages,
            languages: request.recognitionLanguages,
            lines: lines
        )
    )
} catch {
    fputs("OCR failed: \(error)\n", stderr)
    exit(1)
}
