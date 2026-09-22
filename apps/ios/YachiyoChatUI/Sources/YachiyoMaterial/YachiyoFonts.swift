import UIKit

/// The desktop typefaces (all bundled with iOS) at Mac size × 1.2, scaled with Dynamic Type.
public enum YachiyoFonts {
    public static func body() -> UIFont { scaled("AvenirNext-Regular", 17, .body) }
    public static func bubble() -> UIFont { scaled("HelveticaNeue", 17, .body) }
    public static func rowTitle() -> UIFont { scaled("AvenirNext-Medium", 16, .callout) }
    public static func preview() -> UIFont { scaled("AvenirNext-Regular", 13, .footnote) }
    public static func sectionTitle() -> UIFont { scaled("AvenirNext-Medium", 13, .footnote) }
    public static func meta() -> UIFont { scaled("AvenirNext-Regular", 13, .footnote) }
    public static func caption() -> UIFont { scaled("AvenirNext-Regular", 12, .caption1) }
    public static func cardTitle() -> UIFont { scaled("AvenirNext-Medium", 15, .subheadline) }
    public static func cardTitleStrong() -> UIFont { scaled("AvenirNext-DemiBold", 15, .subheadline) }
    public static func navigationTitle() -> UIFont { scaled("AvenirNext-DemiBold", 17, .headline) }
    public static func display() -> UIFont { scaled("IowanOldStyle-Roman", 28, .title1) }
    public static func largeTitle() -> UIFont { scaled("IowanOldStyle-Roman", 34, .largeTitle) }

    private static func scaled(_ name: String, _ size: CGFloat, _ style: UIFont.TextStyle) -> UIFont {
        let base = UIFont(name: name, size: size) ?? .systemFont(ofSize: size)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: base)
    }
}
