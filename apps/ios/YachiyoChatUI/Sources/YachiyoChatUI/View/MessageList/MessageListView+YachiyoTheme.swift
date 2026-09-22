import MarkdownView
import UIKit
import YachiyoMaterial

/// Assistant Markdown in the Mac typography (Avenir Next body) and Yachiyo colors.
public extension MessageListView {
    func applyYachiyoTheme() {
        markdownTheme = Self.yachiyoMarkdownTheme()
    }

    static func yachiyoMarkdownTheme() -> MarkdownTheme {
        var theme = MarkdownTheme()
        let body = YachiyoFonts.body()
        theme.fonts.body = body
        theme.fonts.bold = UIFont(descriptor: body.fontDescriptor.withSymbolicTraits(.traitBold) ?? body.fontDescriptor, size: body.pointSize)
        theme.fonts.italic = UIFont(descriptor: body.fontDescriptor.withSymbolicTraits(.traitItalic) ?? body.fontDescriptor, size: body.pointSize)
        theme.fonts.title = UIFont(name: "AvenirNext-DemiBold", size: body.pointSize + 2) ?? body
        theme.fonts.largeTitle = UIFont(name: "AvenirNext-DemiBold", size: body.pointSize + 5) ?? body
        theme.fonts.footnote = YachiyoFonts.meta()
        theme.fonts.code = .monospacedSystemFont(ofSize: body.pointSize * 0.88, weight: .regular)
        theme.fonts.codeInline = .monospacedSystemFont(ofSize: body.pointSize * 0.88, weight: .regular)
        theme.colors.body = .yachiyo(.ink)
        theme.colors.highlight = .yachiyo(.accent)
        theme.colors.emphasis = .yachiyo(.accentStrong)
        theme.colors.code = .yachiyo(.ink)
        theme.colors.codeBackground = YachiyoStyle.ink(0.07)
        return theme
    }
}
