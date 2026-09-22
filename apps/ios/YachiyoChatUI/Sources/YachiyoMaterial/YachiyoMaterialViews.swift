import UIKit

/// Semantic Liquid Glass surfaces with their iOS 17–25 fallbacks. Page code asks for "a floating
/// panel" or "the primary action"; only this file knows which OS draws what.
@MainActor
public enum YachiyoMaterialKit {
    public static var supportsLiquidGlass: Bool {
        if #available(iOS 26, *) { return true }
        return false
    }

    /// A control-layer surface (floating capsules, the offline/read-only banner). iOS 26: glass;
    /// earlier: thick-material blur with a hairline and a soft shadow, like the Mac floating composer.
    public static func makeFloatingSurface(cornerRadius: CGFloat, interactive: Bool = false) -> UIVisualEffectView {
        if #available(iOS 26, *) {
            let glass = UIGlassEffect()
            glass.isInteractive = interactive
            let view = UIVisualEffectView(effect: glass)
            view.cornerConfiguration = .corners(radius: .fixed(cornerRadius))
            return view
        }
        let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
        view.layer.cornerRadius = cornerRadius
        view.layer.cornerCurve = .continuous
        view.clipsToBounds = true
        view.layer.borderWidth = 1
        view.layer.borderColor = YachiyoStyle.ink(0.08).cgColor
        return view
    }

    /// Groups floating glass so iOS 26 can merge and split neighbours; a plain container earlier.
    public static func makeGlassGroup(spacing: CGFloat = 12) -> UIVisualEffectView {
        if #available(iOS 26, *) {
            let effect = UIGlassContainerEffect()
            effect.spacing = spacing
            return UIVisualEffectView(effect: effect)
        }
        return UIVisualEffectView(effect: nil)
    }

    /// The single tinted action on a page (Scan, New, Send).
    public static func primaryButtonConfiguration(title: String?, image: UIImage?) -> UIButton.Configuration {
        var configuration: UIButton.Configuration
        if #available(iOS 26, *) {
            configuration = .prominentGlass()
        } else {
            configuration = .filled()
            configuration.baseBackgroundColor = .yachiyo(.accentFill)
            configuration.baseForegroundColor = .yachiyo(.onAccentFill)
        }
        configuration.title = title
        configuration.image = image
        configuration.imagePadding = 6
        configuration.cornerStyle = .capsule
        return configuration
    }

    /// Secondary control-layer buttons.
    public static func secondaryButtonConfiguration(title: String?, image: UIImage?) -> UIButton.Configuration {
        var configuration: UIButton.Configuration
        if #available(iOS 26, *) {
            configuration = .glass()
        } else {
            configuration = .gray()
        }
        configuration.title = title
        configuration.image = image
        configuration.imagePadding = 6
        configuration.cornerStyle = .capsule
        return configuration
    }

    public static func makeProminent(_ item: UIBarButtonItem) {
        if #available(iOS 26, *) {
            item.style = .prominent
        }
        item.tintColor = .yachiyo(.accent)
    }

    public static func applyTopEdgeEffect(to scrollView: UIScrollView) {
        if #available(iOS 26, *) {
            scrollView.topEdgeEffect.style = .automatic
        }
    }

    /// Shapes the scroll view's bottom edge effect around a floating container (the composer).
    public static func attachBottomEdge(of scrollView: UIScrollView, to container: UIView) {
        if #available(iOS 26, *) {
            let interaction = UIScrollEdgeElementContainerInteraction()
            interaction.scrollView = scrollView
            interaction.edge = .bottom
            container.addInteraction(interaction)
        }
    }

    /// Search lives in the bottom toolbar on iOS 26 and in the navigation bar before that.
    /// Returns the toolbar item when the toolbar placement is available.
    public static func installSearch(_ controller: UISearchController, in navigationItem: UINavigationItem) -> UIBarButtonItem? {
        navigationItem.searchController = controller
        if #available(iOS 26, *) {
            navigationItem.preferredSearchBarPlacement = .integratedButton
            return navigationItem.searchBarPlacementBarButtonItem
        }
        navigationItem.hidesSearchBarWhenScrolling = true
        return nil
    }

    /// Zoom from the tapped control: the bar item on iOS 26, a source view on iOS 18–25, and a
    /// standard sheet on iOS 17.
    public static func prepareZoomTransition(for controller: UIViewController, from item: UIBarButtonItem?, sourceView: UIView? = nil) {
        if #available(iOS 26, *), let item {
            controller.preferredTransition = .zoom(sourceBarButtonItemProvider: { _ in item })
        } else if #available(iOS 18, *), let sourceView {
            controller.preferredTransition = .zoom(sourceViewProvider: { [weak sourceView] _ in sourceView })
        }
    }

    /// Sheets: medium detents keep the system material; large ones use the opaque canvas.
    public static func configureSheet(_ controller: UIViewController, detents: [UISheetPresentationController.Detent]) {
        guard let sheet = controller.sheetPresentationController else { return }
        sheet.detents = detents
        sheet.prefersGrabberVisible = true
        if !supportsLiquidGlass {
            controller.view.backgroundColor = .yachiyo(.canvas)
        }
    }
}
