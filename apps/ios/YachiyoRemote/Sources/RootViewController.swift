import UIKit
import YachiyoMaterial

/// Placeholder root until the inbox lands.
final class RootViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Yachiyo"
        let palette = YachiyoThemePalettes.palette(.mizu, traitCollection.userInterfaceStyle == .dark ? .dark : .light)
        view.backgroundColor = palette.canvas.color()
    }
}
