import UIKit
import YachiyoMaterial

/// The Yachiyo brand portrait (`resources/branding.jpeg` on the Mac), drawn like the Mac welcome
/// avatar: a circle with a hairline surface border, a 7 pt translucent surface ring and a soft
/// drop shadow.
final class BrandAvatarView: UIView {
    static let image = UIImage(named: "Branding")

    private let imageView = UIImageView(image: BrandAvatarView.image)
    private let ring = CAShapeLayer()
    private let diameter: CGFloat

    init(diameter: CGFloat = 82) {
        self.diameter = diameter
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityLabel = "Yachiyo"
        accessibilityTraits = .image

        layer.addSublayer(ring)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = diameter / 2
        imageView.layer.borderWidth = 1
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: diameter),
            heightAnchor.constraint(equalToConstant: diameter),
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        layer.shadowOpacity = 1
        layer.shadowRadius = 19
        layer.shadowOffset = CGSize(width: 0, height: 18)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: BrandAvatarView, _) in
            view.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let circle = UIBezierPath(ovalIn: bounds)
        layer.shadowPath = circle.cgPath
        ring.path = UIBezierPath(ovalIn: bounds.insetBy(dx: -7, dy: -7)).cgPath
    }

    private func applyColors() {
        imageView.layer.borderColor = UIColor.yachiyo(.surface, alpha: 0.72).cgColor
        ring.fillColor = UIColor.yachiyo(.surface, alpha: 0.46).cgColor
        layer.shadowColor = YachiyoStyle.ink(0.14).cgColor
    }
}
