import Foundation
import Vision

enum OcrCliCommand: Equatable {
    case recognize
    case listLanguages
}

enum OcrLanguageMode: String, Codable, Equatable {
    case automatic
    case system
    case all
    case explicit
}

enum OcrRecognitionLevelOption: String, Codable, Equatable {
    case accurate
    case fast

    var visionLevel: VNRequestTextRecognitionLevel {
        switch self {
        case .accurate:
            return .accurate
        case .fast:
            return .fast
        }
    }
}

struct CliOptions: Equatable {
    var command: OcrCliCommand = .recognize
    var imagePath: String?
    var languageMode: OcrLanguageMode = .automatic
    var requestedLanguages: [String] = []
    var recognitionLevel: OcrRecognitionLevelOption = .accurate
}

enum CliOptionsError: Error, CustomStringConvertible {
    case missingValue(String)
    case unknownOption(String)
    case missingImagePath
    case invalidRecognitionLevel(String)
    case conflictingLanguageModes

    var description: String {
        switch self {
        case let .missingValue(option):
            return "Missing value for \(option)"
        case let .unknownOption(option):
            return "Unknown option: \(option)"
        case .missingImagePath:
            return "Missing image path"
        case let .invalidRecognitionLevel(value):
            return "Invalid recognition level: \(value)"
        case .conflictingLanguageModes:
            return "Use either --languages or --language, not both"
        }
    }
}

func parseCliOptions(_ args: [String]) throws -> CliOptions {
    var options = CliOptions()
    var index = 0
    var sawLanguagesOption = false
    var sawLanguageOption = false

    func readValue(after option: String) throws -> String {
        let valueIndex = index + 1
        guard valueIndex < args.count else { throw CliOptionsError.missingValue(option) }
        let value = args[valueIndex]
        guard !value.hasPrefix("--") else { throw CliOptionsError.missingValue(option) }
        index = valueIndex
        return value
    }

    while index < args.count {
        let arg = args[index]
        switch arg {
        case "--list-languages":
            options.command = .listLanguages
        case "--recognition-level":
            let value = try readValue(after: arg)
            guard let level = OcrRecognitionLevelOption(rawValue: value) else {
                throw CliOptionsError.invalidRecognitionLevel(value)
            }
            options.recognitionLevel = level
        case "--languages":
            if sawLanguageOption { throw CliOptionsError.conflictingLanguageModes }
            sawLanguagesOption = true
            let value = try readValue(after: arg)
            switch value {
            case "auto", "automatic":
                options.languageMode = .automatic
                options.requestedLanguages = []
            case "system":
                options.languageMode = .system
                options.requestedLanguages = []
            case "all":
                options.languageMode = .all
                options.requestedLanguages = []
            default:
                options.languageMode = .explicit
                options.requestedLanguages = value
                    .split(separator: ",")
                    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
            }
        case "--language":
            if sawLanguagesOption { throw CliOptionsError.conflictingLanguageModes }
            sawLanguageOption = true
            options.languageMode = .explicit
            options.requestedLanguages.append(try readValue(after: arg))
        default:
            if arg.hasPrefix("--") {
                throw CliOptionsError.unknownOption(arg)
            }
            if options.imagePath == nil {
                options.imagePath = arg
            } else {
                throw CliOptionsError.unknownOption(arg)
            }
        }

        index += 1
    }

    if options.command == .recognize && options.imagePath == nil {
        throw CliOptionsError.missingImagePath
    }

    return options
}

func canonicalLanguageCandidates(_ language: String) -> [String] {
    let normalized = language.replacingOccurrences(of: "_", with: "-")
    var candidates = [normalized]
    if let base = normalized.split(separator: "-").first.map(String.init), base != normalized {
        candidates.append(base)
    }
    return candidates
}

func resolveRecognitionLanguages(
    options: CliOptions,
    supportedLanguages: [String],
    systemPreferredLanguages: [String] = Locale.preferredLanguages
) throws -> [String] {
    let supported = Set(supportedLanguages)

    switch options.languageMode {
    case .automatic:
        return []
    case .all:
        return supportedLanguages
    case .system:
        var resolved: [String] = []
        for preferred in systemPreferredLanguages {
            for candidate in canonicalLanguageCandidates(preferred) where supported.contains(candidate) {
                if !resolved.contains(candidate) {
                    resolved.append(candidate)
                }
                break
            }
        }
        return resolved
    case .explicit:
        let resolved = options.requestedLanguages.flatMap(canonicalLanguageCandidates).filter {
            supported.contains($0)
        }
        return Array(NSOrderedSet(array: resolved)) as? [String] ?? []
    }
}
