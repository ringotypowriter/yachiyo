//
//  QuestionCardView.swift
//  YachiyoChatUI
//
//  askUser card: the question, up to four stacked choices (wrapping chips beyond that), and a
//  free-form answer field. Collapses to "question · answer" once answered.
//

import MarkdownView
import UIKit
import YachiyoMaterial

final class QuestionCardView: MessageListRowView {
    static let padding: CGFloat = 14
    static let choiceHeight: CGFloat = 44
    static let chipHeight: CGFloat = 34
    static let spacing: CGFloat = 8

    var question: QuestionContentPart? { didSet { rebuild() } }
    var onAnswer: ((String) -> Void)?

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
        textField.addAction(UIAction { [weak self] _ in self?.updateSendButton() }, for: .editingChanged)
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
            let chips = question.choices.count > 4
            for choice in question.choices {
                stack.addArrangedSubview(makeChoiceButton(choice, compact: chips))
            }
            stack.isHidden = question.choices.isEmpty
            inputRow.isHidden = false
            textField.text = ""
        } else {
            titleLabel.text = "\(question.question) · \(question.answer ?? String.localized("Answered"))"
            icon.image = UIImage(systemName: "checkmark.bubble")
            stack.isHidden = true
            inputRow.isHidden = true
        }
        themeDidUpdate()
        setNeedsLayout()
    }

    private func makeChoiceButton(_ choice: String, compact: Bool) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.title = choice
        configuration.baseForegroundColor = .yachiyo(.ink)
        configuration.background.backgroundColor = .yachiyo(.surface)
        configuration.background.cornerRadius = 10
        configuration.background.strokeColor = YachiyoStyle.ink(0.08)
        configuration.background.strokeWidth = 1
        configuration.titleAlignment = .leading
        let button = UIButton(configuration: configuration)
        button.contentHorizontalAlignment = .leading
        button.accessibilityIdentifier = "question.choice.\(choice)"
        button.configurationUpdateHandler = { button in
            var updated = button.configuration
            updated?.background.backgroundColor = button.isHighlighted ? .yachiyo(.accent, alpha: 0.10) : .yachiyo(.surface)
            updated?.baseForegroundColor = button.isHighlighted ? .yachiyo(.accentStrong) : .yachiyo(.ink)
            button.configuration = updated
        }
        button.addAction(UIAction { [weak self] _ in self?.submit(choice) }, for: .touchUpInside)
        button.heightAnchor.constraint(equalToConstant: compact ? Self.chipHeight : Self.choiceHeight).isActive = true
        return button
    }

    private func updateSendButton() {
        let hasText = !(textField.text ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        sendButton.tintColor = hasText ? .yachiyo(.accentFill) : .yachiyo(.textPlaceholder)
        sendButton.isEnabled = hasText
    }

    private func submitTypedAnswer() {
        let text = (textField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        submit(text)
    }

    private func submit(_ answer: String) {
        textField.resignFirstResponder()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onAnswer?(answer)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        card.frame = contentView.bounds
        let padding = Self.padding
        let width = card.bounds.width - padding * 2
        icon.frame = CGRect(x: padding, y: padding, width: 20, height: 20)
        let titleWidth = width - 28
        let titleHeight = ceil(titleLabel.sizeThatFits(CGSize(width: titleWidth, height: .greatestFiniteMagnitude)).height)
        titleLabel.frame = CGRect(x: padding + 28, y: padding, width: titleWidth, height: max(20, titleHeight))
        var y = titleLabel.frame.maxY + Self.spacing
        if !stack.isHidden {
            let stackHeight = stack.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
            stack.frame = CGRect(x: padding, y: y, width: width, height: stackHeight)
            y = stack.frame.maxY + Self.spacing
        }
        if !inputRow.isHidden {
            inputRow.frame = CGRect(x: padding, y: y, width: width, height: Self.choiceHeight)
            textField.frame = CGRect(x: 12, y: 0, width: width - 56, height: Self.choiceHeight)
            sendButton.frame = CGRect(x: width - 44, y: 0, width: 44, height: Self.choiceHeight)
        }
    }

    static func height(for question: QuestionContentPart, width: CGFloat) -> CGFloat {
        let titleText = question.isWaiting ? question.question : "\(question.question) · \(question.answer ?? "")"
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
            let each = question.choices.count > 4 ? chipHeight : choiceHeight
            height += CGFloat(question.choices.count) * (each + spacing) - spacing + spacing
        }
        height += choiceHeight + spacing
        return height
    }
}
