import Testing
@testable import VisionOcr

@Test func ocrResultTextJoinsLinesWithoutLayoutBoxes() {
    let result = OcrResult(
        imagePath: "/tmp/screenshot.png",
        revision: 3,
        recognitionLevel: "accurate",
        languageMode: "automatic",
        requestedLanguages: [],
        systemPreferredLanguages: ["ja-JP", "en-US"],
        languages: [],
        lines: [
            OcrLine(text: "八千代", confidence: 0.98),
            OcrLine(text: "Yachiyo", confidence: 0.97)
        ]
    )

    #expect(result.schemaVersion == 1)
    #expect(result.engine == "apple-vision")
    #expect(result.text == "八千代\nYachiyo")
}

