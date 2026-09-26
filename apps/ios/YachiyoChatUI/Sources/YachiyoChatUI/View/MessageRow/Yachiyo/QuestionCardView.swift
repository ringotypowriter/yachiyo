//
//  QuestionCardView.swift
//  YachiyoChatUI
//
//  askUser card: the question, wrapping stacked choices, and a
//  free-form answer field. Collapses to "question · answer" once answered.
//

import MarkdownView
import UIKit
import YachiyoMaterial

final class QuestionCardView: MessageListRowView {
    static let padding: CGFloat = 14
    static let choiceHeight: CGFloat = 44
    static let spacing: CGFloat = 8

    var question: QuestionContentPart? {
        didSet {
            guard oldValue != question else { return }
            if oldValue?.id != question?.id { textField.text = "" }
            rebuild()
        }
    }
    var onAnswer: ((String) -> Void)?
    var onDraftChange: ((String) -> Void)?

    var draft: String {
        get { textField.text ?? "" }
        set {
            if textField.text != newValue { textField.text = newValue }
            updateSendButton()
        }
    }

    private let card = UIView()
    private let icon = UIImageView()
    private let titleLabel = UILabel()
    private let stack = UIStackView()
    private let inputRow = UIView()
    private let textField = UITextField()
    private let sendButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.layer.cornerRadius = 12
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1
        contentView.addSubview(card)

        icon.image = UIImage(systemName: "questionmark.bubble")
        icon.contentMode = .scaleAspectFit
        card.addSubview(icon)

        titleLabel.numberOfLines = 0
        titleLabel.font = YachiyoFonts.cardTitle()
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.accessibilityIdentifier = "question.title"
        card.addSubview(titleLabel)

        stack.axis = .vertical
        stack.spacing = Self.spacing
        card.addSubview(stack)

        textField.placeholder = String.localized("Type an answer…")
        textField.font = YachiyoFonts.body()
        textField.accessibilityIdentifier = "question.input"
        textField.returnKeyType = .send
        textField.addAction(UIAction { [weak self] _ in self?.submitTypedAnswer() }, for: .editingDidEndOnExit)
        textField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            updateSendButton()
            onDraftChange?(draft)
        }, for: .editingChanged)
        inputRow.addSubview(textField)
        sendButton.setImage(UIImage(systemName: "arrow.up.circle.fill"), for: .normal)
        sendButton.accessibilityIdentifier = "question.send"
        sendButton.accessibilityLabel = String.localized("Send answer")
        sendButton.addAction(UIAction { [weak self] _ in self?.submitTypedAnswer() }, for: .touchUpInside)
        inputRow.addSubview(sendButton)
        card.addSubview(inputRow)
    }

    override func themeDidUpdate() {
        super.themeDidUpdate()
        card.backgroundColor = .yachiyo(.surface)
        card.layer.borderColor = YachiyoStyle.ink(0.06).resolvedColor(with: traitCollection).cgColor
        icon.tintColor = .yachiyo(.accent)
        titleLabel.textColor = .yachiyo(.ink)
        inputRow.backgroundColor = YachiyoStyle.ink(0.04)
        inputRow.layer.cornerRadius = 10
        updateSendButton()
    }

    private func rebuild() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let question else { return }
        accessibilityIdentifier = "question.card"
        if question.isWaiting {
            titleLabel.text = question.question
            icon.image = UIImage(systemName: "questionmark.bubble.fill")
            for choice in question.choices {
                stack.addArrangedSubview(makeChoiceButton(choice))
            }
            stack.isHidden = question.choices.isEmpty
            inputRow.isHidden = false
        } else {
            textField.resignFirstResponder()
            titleLabel.text = "\(question.question) · \(question.answer ?? String.localized("Answered"))"
            icon.image = UIImage(systemName: "checkmark.bubble")
            stack.isHidden = true
            inputRow.isHidden = true
        }
        updateSendButton()
        setNeedsContentLayout()
    }

    private func makeChoiceButton(_ choice: String) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.title = choice
        configuration.baseForegroundColor = .yachiyo(.ink)
        configuration.background.backgroundColor = .yachiyo(.surface)
        configuration.background.cornerRadius = 10
        configuration.background.strokeColor = YachiyoStyle.ink(0.08)
        configuration.background.strokeWidth = 1
        configuration.titleAlignment = .leading
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
        configuration.titleLineBreakMode = .byWordWrapping
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = YachiyoFonts.body()
            return attributes
        }
        let button = UIButton(configuration: configuration)
        button.titleLabel?.numberOfLines = 0
        button.contentHorizontalAlignment = .leading
        button.accessibilityIdentifier = "question.choice.\(choice)"
        button.configurationUpdateHandler = { button in
            var updated = button.configuration
            updated?.background.backgroundColor = button.isHighlighted ? .yachiyo(.accent, alpha: 0.10) : .yachiyo(.surface)
            updated?.baseForegroundColor = button.isHighlighted ? .yachiyo(.accentStrong) : .yachiyo(.ink)
            button.configuration = updated
        }
        button.addAction(UIAction { [weak self] _ in self?.submit(choice) }, for: .touchUpInside)
        return button
    }

    private func updateSendButton() {
        let hasText = !(textField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        sendButton.tintColor = hasText ? .yachiyo(.accentFill) : .yachiyo(.textPlaceholder)
        sendButton.isEnabled = hasText
    }

    private func submitTypedAnswer() {
        let text = (textField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        submit(text)
    }

    private func submit(_ answer: String) {
        guard question?.isWaiting == true else { return }
        textField.resignFirstResponder()
        UISelectionFeedbackGenerator().selectionChanged()
        onAnswer?(answer)
    }

    /// Choice heights for the last laid-out width, so relayouts skip the text measurement.
    private var choiceHeightCache: (width: CGFloat, choices: [String], heights: [CGFloat])?

    private func choiceHeights(width: CGFloat) -> [CGFloat] {
        let choices = question?.choices ?? []
        if let cache = choiceHeightCache, cache.width == width, cache.choices == choices { return cache.heights }
        let heights = choices.map { Self.choiceHeight(for: $0, width: width) }
        choiceHeightCache = (width, choices, heights)
        return heights
    }

    override func layoutContent() {
        card.frame = contentView.bounds
        let padding = Self.padding
        let width = card.bounds.width - padding * 2
        icon.frame = CGRect(x: padding, y: padding, width: 20, height: 20)
        let titleWidth = width - 28
        let titleHeight = ceil(titleLabel.sizeThatFits(CGSize(width: titleWidth, height: .greatestFiniteMagnitude)).height)
        titleLabel.frame = CGRect(x: padding + 28, y: padding, width: titleWidth, height: max(20, titleHeight))
        var y = titleLabel.frame.maxY + Self.spacing
        if !stack.isHidden {
            let heights = choiceHeights(width: width)
            for (button, height) in zip(stack.arrangedSubviews, heights) {
                if let constraint = button.constraints.first(where: { $0.firstAttribute == .height }) {
                    constraint.constant = height
                } else {
                    button.heightAnchor.constraint(equalToConstant: height).isActive = true
                }
            }
            let stackHeight = heights.reduce(0, +) + CGFloat(max(0, heights.count - 1)) * Self.spacing
            stack.frame = CGRect(x: padding, y: y, width: width, height: stackHeight)
            y = stack.frame.maxY + Self.spacing
        }
        if !inputRow.isHidden {
            inputRow.frame = CGRect(x: padding, y: y, width: width, height: Self.choiceHeight)
            textField.frame = CGRect(x: 12, y: 0, width: width - 56, height: Self.choiceHeight)
            sendButton.frame = CGRect(x: width - 44, y: 0, width: 44, height: Self.choiceHeight)
        }
    }

    static func choiceHeight(for choice: String, width: CGFloat) -> CGFloat {
        let textHeight = ceil((choice as NSString).boundingRect(
            with: CGSize(width: max(1, width - 24), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: YachiyoFonts.body()],
            context: nil
        ).height)
        return max(choiceHeight, textHeight + 20)
    }

    static func height(for question: QuestionContentPart, width: CGFloat) -> CGFloat {
        let titleText = question.isWaiting ? question.question : "\(question.question) · \(question.answer ?? String.localized("Answered"))"
        let titleWidth = width - padding * 2 - 28
        let titleHeight = max(20, ceil((titleText as NSString).boundingRect(
            with: CGSize(width: titleWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: YachiyoFonts.cardTitle()],
            context: nil
        ).height))
        var height = padding + titleHeight + padding
        guard question.isWaiting else { return height }
        if !question.choices.isEmpty {
            height += question.choices.reduce(0) { $0 + choiceHeight(for: $1, width: width - padding * 2) + spacing }
        }
        height += choiceHeight + spacing
        return height
    }
}
