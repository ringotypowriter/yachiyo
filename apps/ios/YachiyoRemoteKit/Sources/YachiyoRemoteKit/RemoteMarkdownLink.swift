import Foundation

/// Local targets belong to the Mac, never the phone's file system or external URL handlers.
public enum RemoteMarkdownLink: Equatable, Sendable {
    case external(URL)
    case workspaceFile(String)
    case unsupported

    public init(_ destination: String) {
        let value = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.hasPrefix("#") else { self = .unsupported; return }
        if value.hasPrefix("//"), let url = URL(string: "https:" + value), url.host != nil {
            self = .external(url)
            return
        }
        guard let url = URL(string: value) else { self = .unsupported; return }
        switch url.scheme?.lowercased() {
        case "http", "https":
            self = url.host == nil ? .unsupported : .external(url)
        case "mailto", "tel":
            self = .external(url)
        case nil, "file":
            self = .workspaceFile(value)
        default:
            self = .unsupported
        }
    }
}
