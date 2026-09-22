import UIKit

/// Semantic color tokens shared with the desktop CSS (`--yachiyo-rgb-*`).
public enum YachiyoToken: CaseIterable, Sendable {
    case ink, textSecondary, textTertiary, textMuted, textPlaceholder
    case app, canvas, dock, surface
    case accent, accentStrong, onAccent, accentFill, onAccentFill
    case counter, counterStrong, scrim, onAccentOverlay
    case success, successStrong, warning, danger, dangerStrong, idle

    func rgb(in palette: YachiyoPalette) -> YachiyoRGB {
        switch self {
        case .ink: palette.ink
        case .textSecondary: palette.textSecondary
        case .textTertiary: palette.textTertiary
        case .textMuted: palette.textMuted
        case .textPlaceholder: palette.textPlaceholder
        case .app: palette.app
        case .canvas: palette.canvas
        case .dock: palette.dock
        case .surface: palette.surface
        case .accent: palette.accent
        case .accentStrong: palette.accentStrong
        case .onAccent: palette.onAccent
        case .accentFill: palette.accentFill
        case .onAccentFill: palette.onAccentFill
        case .counter: palette.counter
        case .counterStrong: palette.counterStrong
        case .scrim: palette.scrim
        case .onAccentOverlay: palette.onAccentOverlay
        case .success: palette.success
        case .successStrong: palette.successStrong
        case .warning: palette.warning
        case .danger: palette.danger
        case .dangerStrong: palette.dangerStrong
        case .idle: palette.idle
        }
    }
}

public enum YachiyoAppearancePreference: String, Sendable {
    case system, light, dark

    public var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }
}

/// The active Yachiyo theme. Colors are dynamic providers, so a theme switch only needs the
/// windows to redraw; `didChangeNotification` tells views that cache colors to refresh.
public enum YachiyoStyle {
    public static let didChangeNotification = Notification.Name("YachiyoStyleDidChange")

    private static let lock = NSLock()
    nonisolated(unsafe) private static var storedThemeID: YachiyoThemeID = .mizu

    public static var themeID: YachiyoThemeID {
        lock.withLock { storedThemeID }
    }

    @MainActor
    public static func apply(themeID: YachiyoThemeID, appearance: YachiyoAppearancePreference, to windows: [UIWindow]) {
        lock.withLock { storedThemeID = themeID }
        for window in windows {
            window.overrideUserInterfaceStyle = appearance.interfaceStyle
            window.tintColor = color(.accent)
            refresh(window)
        }
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    public static func palette(for traits: UITraitCollection) -> YachiyoPalette {
        YachiyoThemePalettes.palette(themeID, traits.userInterfaceStyle == .dark ? .dark : .light)
    }

    public static func color(_ token: YachiyoToken, alpha: CGFloat = 1) -> UIColor {
        UIColor { traits in
            let resolved = token.rgb(in: palette(for: traits))
            // Reduce Transparency: content-layer tints become opaque.
            let effectiveAlpha = UIAccessibility.isReduceTransparencyEnabled && alpha < 1 ? 1 : alpha
            return resolved.color(alpha: effectiveAlpha)
        }
    }

    /// Alpha-over-surface variant used for hairlines and pressed states (`ink@0.08` etc.).
    public static func ink(_ alpha: CGFloat) -> UIColor {
        UIColor { traits in
            palette(for: traits).ink.color(alpha: alpha)
        }
    }

    @MainActor
    private static func refresh(_ view: UIView) {
        view.setNeedsLayout()
        view.setNeedsDisplay()
        for subview in view.subviews { refresh(subview) }
    }
}

public extension UIColor {
    static func yachiyo(_ token: YachiyoToken, alpha: CGFloat = 1) -> UIColor {
        YachiyoStyle.color(token, alpha: alpha)
    }

    /// Thread color tags, as on the desktop sidebar.
    static func yachiyoColorTag(_ tag: String) -> UIColor? {
        switch tag {
        case "coral": UIColor(red: 0.91, green: 0.45, blue: 0.38, alpha: 1)
        case "azure": UIColor(red: 0.29, green: 0.56, blue: 0.85, alpha: 1)
        case "emerald": UIColor(red: 0.24, green: 0.66, blue: 0.47, alpha: 1)
        case "amethyst": UIColor(red: 0.6, green: 0.43, blue: 0.82, alpha: 1)
        case "slate": UIColor(red: 0.45, green: 0.5, blue: 0.56, alpha: 1)
        default: nil
        }
    }
}
