import Foundation

/// The tool reader's text as ordered sections. A refresh rebuilds the document; positions and
/// selections are carried over by section and offset, so text added or removed in another
/// section does not move what the reader was looking at. Offsets are UTF-16, like `NSRange`.
struct ToolPreviewDocument: Equatable {
    enum Key: Equatable {
        case notice, title, input, output, error
        case parameter(String)
    }

    struct Section: Equatable {
        let key: Key
        let heading: String?
        let body: String
        var language: String? = nil
    }

    /// Decode complete object inputs into readable fields. A shortened or non-object preview
    /// stays intact rather than guessing at missing arguments.
    static func inputSections(input: String?, title: String?, toolName: String) -> [Section] {
        let object = input.flatMap { $0.data(using: .utf8) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        let description = (object?["description"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? title
        var sections: [Section] = []
        if let description, !description.isEmpty {
            sections.append(Section(key: .title, heading: "Description", body: description))
        }
        guard let input else { return sections }
        guard var object, !object.isEmpty else {
            sections.append(Section(key: .input, heading: "Input", body: input))
            return sections
        }
        if object["description"] is String { object.removeValue(forKey: "description") }
        let priority = ["command", "code"]
        let keys = priority.filter { object[$0] != nil } + object.keys.filter { !priority.contains($0) }.sorted()
        for key in keys {
            guard let value = object[key] else { continue }
            let body: String
            let language: String?
            if let string = value as? String {
                body = string
                switch key {
                case "command": language = "bash"
                case "code": language = toolName.lowercased().contains("py") ? "python" : "javascript"
                default: language = nil
                }
            } else {
                let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
                body = data.flatMap { String(data: $0, encoding: .utf8) } ?? String(describing: value)
                language = "json"
            }
            let label = key.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
                .replacingOccurrences(of: "_", with: " ")
            sections.append(Section(key: .parameter(key), heading: label.prefix(1).uppercased() + label.dropFirst(), body: body, language: language))
        }
        return sections
    }

    /// A place in one section's body.
    struct Location: Equatable {
        let key: Key
        let offset: Int
    }

    let sections: [Section]
    /// The rendered text: each section's heading line, then its body, separated by blank lines.
    let text: String
    /// Where each section starts (its heading, if any) and where its body sits in `text`.
    private let ranges: [(key: Key, start: Int, body: NSRange)]

    static let separator = "\n\n"

    init(sections: [Section]) {
        self.sections = sections
        var text = ""
        var ranges: [(key: Key, start: Int, body: NSRange)] = []
        for (index, section) in sections.enumerated() {
            if index > 0 { text += Self.separator }
            let start = text.utf16.count
            if let heading = section.heading { text += heading + "\n" }
            let body = NSRange(location: text.utf16.count, length: section.body.utf16.count)
            text += section.body
            ranges.append((section.key, start, body))
        }
        self.text = text
        self.ranges = ranges
    }

    static func == (lhs: ToolPreviewDocument, rhs: ToolPreviewDocument) -> Bool {
        lhs.sections == rhs.sections
    }

    func headingRange(of key: Key) -> NSRange? {
        guard let range = ranges.first(where: { $0.key == key }), range.body.location > range.start else { return nil }
        return NSRange(location: range.start, length: range.body.location - range.start)
    }

    func bodyRange(of key: Key) -> NSRange? {
        ranges.first { $0.key == key }?.body
    }

    /// The section holding `index`; a heading or separator maps to the start of the next body.
    func location(at index: Int) -> Location? {
        for range in ranges where index < NSMaxRange(range.body) || range.key == ranges.last?.key {
            return Location(key: range.key, offset: min(max(0, index - range.body.location), range.body.length))
        }
        return nil
    }

    /// The text index of `location` here. Offsets past a shorter body clamp to its end; a section
    /// this document no longer has resolves to where the next surviving one begins.
    func index(of location: Location, after previous: ToolPreviewDocument) -> Int {
        if let range = bodyRange(of: location.key) {
            return range.location + min(location.offset, range.length)
        }
        let order = previous.sections.map(\.key)
        let following = order.drop { $0 != location.key }.dropFirst()
        for key in following {
            if let range = ranges.first(where: { $0.key == key }) { return range.start }
        }
        return text.utf16.count
    }

    /// A selection made in `previous`, kept only while the selected characters and everything
    /// before them in their section are unchanged; anything else ends the selection.
    func carry(selection: NSRange, from previous: ToolPreviewDocument) -> NSRange? {
        guard selection.length > 0,
              let start = previous.location(at: selection.location),
              let oldBody = previous.bodyRange(of: start.key),
              NSMaxRange(selection) <= NSMaxRange(oldBody),
              selection.location >= oldBody.location,
              let newBody = bodyRange(of: start.key)
        else { return nil }
        let prefixLength = NSMaxRange(selection) - oldBody.location
        guard prefixLength <= newBody.length else { return nil }
        let oldPrefix = (previous.text as NSString).substring(with: NSRange(location: oldBody.location, length: prefixLength))
        let newPrefix = (text as NSString).substring(with: NSRange(location: newBody.location, length: prefixLength))
        guard oldPrefix == newPrefix else { return nil }
        return NSRange(location: newBody.location + start.offset, length: selection.length)
    }
}
