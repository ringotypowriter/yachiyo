//
//  DeleteButton.swift
//  LanguageModelChatUI
//

import UIKit

class DeleteButton: UIView {
    let background = UIView()
    let imageView = UIImageView()

    var actionBlock: () -> Void = {}

    init() {
        super.init(frame: .zero)

        addSubview(background)
        background.backgroundColor = .gray.withAlphaComponent(0.75)

        addSubview(imageView)
        imageView.tintColor = .systemBackground
        imageView.contentMode = .scaleAspectFit
        let configuration = UIImage.SymbolConfiguration(weight: .heavy)
        imageView.image = UIImage(systemName: "xmark", withConfiguration: configuration)

        let tap = UITapGestureRecognizer(target: self, action: #selector(onTapped))
        addGestureRecognizer(tap)
        isUserInteractionEnabled = true
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = String.localized("Remove attachment")
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError()
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        background.frame = CGRect(x: bounds.width - 24, y: 4, width: 20, height: 20)
        background.layer.cornerRadius = 10

        imageView.frame = background.frame.insetBy(dx: 5, dy: 5)
    }

    override func accessibilityActivate() -> Bool {
        guard !isHidden, isUserInteractionEnabled else { return false }
        onTapped()
        return true
    }

    @objc func onTapped() {
        puddingAnimate()
        actionBlock()
    }
}
