import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// Color theme can follow the primary desktop; light/dark always follows this device's system.
/// `-YachiyoThemeOverride <id>` can select a color theme for screenshot runs.
@MainActor
final class ThemeController {
    static let shared = ThemeController()

    private let defaults = UserDefaults.standard
    private var desktopAppearance: RemoteAppearance?

    var themeOverride: YachiyoThemeID? {
        get { defaults.string(forKey: "YachiyoThemeOverride").flatMap(YachiyoThemeID.init(rawValue:)) }
        set {
            defaults.set(newValue?.rawValue, forKey: "YachiyoThemeOverride")
            apply()
        }
    }

    var effectiveTheme: YachiyoThemeID {
        themeOverride ?? desktopAppearance.flatMap { YachiyoThemeID(rawValue: $0.themeId.rawValue) } ?? .mizu
    }

    func desktopAppearanceDidChange(_ appearance: RemoteAppearance) {
        desktopAppearance = appearance
        apply()
    }

    func apply() {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        YachiyoStyle.apply(themeID: effectiveTheme, appearance: .system, to: windows)
    }
}
