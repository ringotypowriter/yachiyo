import Testing
@testable import VisionOcr

@Test func parseCliOptionsDefaultsToAutomaticLanguages() throws {
    let options = try parseCliOptions(["/tmp/screenshot.png"])

    #expect(options.command == .recognize)
    #expect(options.imagePath == "/tmp/screenshot.png")
    #expect(options.languageMode == .automatic)
    #expect(options.requestedLanguages.isEmpty)
    #expect(options.recognitionLevel == .accurate)
}

@Test func parseCliOptionsSupportsLanguageListingAndRecognitionLevel() throws {
    let options = try parseCliOptions(["--list-languages", "--recognition-level", "fast"])

    #expect(options.command == .listLanguages)
    #expect(options.imagePath == nil)
    #expect(options.languageMode == .automatic)
    #expect(options.recognitionLevel == .fast)
}

@Test func parseCliOptionsSupportsSystemAndExplicitLanguageModes() throws {
    let systemOptions = try parseCliOptions(["--languages", "system", "/tmp/screenshot.png"])
    let explicitOptions = try parseCliOptions([
        "--language", "ja-JP",
        "--language", "ko-KR",
        "/tmp/screenshot.png"
    ])

    #expect(systemOptions.languageMode == .system)
    #expect(systemOptions.requestedLanguages.isEmpty)
    #expect(explicitOptions.languageMode == .explicit)
    #expect(explicitOptions.requestedLanguages == ["ja-JP", "ko-KR"])
}
