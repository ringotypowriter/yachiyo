import UIKit
import YachiyoMaterial
import YachiyoRemoteKit

/// Applies the Yachiyo theme: the primary desktop's theme by default, or a phone-local override
/// from Settings. `-YachiyoThemeOverride <id>` / `-YachiyoAppearanceOverride <mode>` launch
/// arguments (UserDefaults argument domain) drive screenshot runs.
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

    var appearanceOverride: YachiyoAppearancePreference? {
        get { defaults.string(forKey: "YachiyoAppearanceOverride").flatMap(YachiyoAppearancePreference.init(rawValue:)) }
        set {
            defaults.set(newValue?.rawValue, forKey: "YachiyoAppearanceOverride")
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
        let appearance = appearanceOverride
            ?? desktopAppearance.flatMap { YachiyoAppearancePreference(rawValue: $0.themeAppearance.rawValue) }
            ?? .system
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        YachiyoStyle.apply(themeID: effectiveTheme, appearance: appearance, to: windows)
    }
}
