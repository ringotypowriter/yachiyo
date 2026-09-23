//
//  InputEditor.swift
//  LanguageModelChatUI
//

import Combine
import UIKit

class InputEditor: EditorSectionView {
    let font = UIFont.preferredFont(forTextStyle: .body)
    let textHeight: CurrentValueSubject<CGFloat, Never> = .init(0)
    let maxTextEditorHeight: CGFloat = 200

    let elementClipper = UIView()

    let bossButton = UIButton(type: .system)
    let textView = TextEditorView()
    let placeholderLabel = UILabel()
    let voiceButton = IconButton(icon: "mic")
    let moreButton = IconButton(icon: "plus.circle")
    let sendButton = IconButton(icon: "send")
    let submissionSpinner = UIActivityIndicatorView(style: .medium)

    var hasAttachments = false {
        didSet { switchToRequiredStatus() }
    }

    var isSubmitting = false {
        didSet {
            guard oldValue != isSubmitting else { return }
            sendButton.isUserInteractionEnabled = !isSubmitting
            if isSubmitting { submissionSpinner.startAnimating() }
            else { submissionSpinner.stopAnimating() }
            setNeedsLayout()
        }
    }
    /// Shown instead of the more/mic button while a run is active (Yachiyo fork).
    let stopButton = IconButton(icon: "stop.circle.fill")

    var isRunning: Bool = false {
        didSet {
            guard oldValue != isRunning else { return }
            doWithAnimation { self.setNeedsLayout(); self.layoutIfNeeded() }
        }
    }

    let inset: UIEdgeInsets = .init(top: 10, left: 10, bottom: 10, right: 10)
    let iconSpacing: CGFloat = 4
    let iconSize = CGSize(width: 44, height: 44)

    var isControlPanelOpened: Bool = false {
        didSet { moreButton.change(icon: isControlPanelOpened ? "x.circle" : "plus.circle") }
    }

    enum LayoutStatus {
        case standard
        case preFocusText
        case editingText
    }

    var layoutStatus: LayoutStatus = .standard {
        didSet {
            guard oldValue != layoutStatus else { return }
            setNeedsLayout()
        }
    }

    /// Configuration injected from ChatInputView.
    var configuration: ChatInputConfiguration = .default

    weak var delegate: Delegate?

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func initializeViews() {
        super.initializeViews()

        bossButton.setImage(UIImage(systemName: "photo"), for: .normal)
        bossButton.setPreferredSymbolConfiguration(.init(pointSize: 24), forImageIn: .normal)
        bossButton.tintColor = .label
        bossButton.showsMenuAsPrimaryAction = true
        let photoLibrary = UIAction(
            title: String.localized("Photo Library"),
            image: UIImage(systemName: "photo.on.rectangle"),
            identifier: UIAction.Identifier("media.photoLibrary")
        ) { [weak self] _ in
            self?.delegate?.onInputEditorPickPhotoButtonTapped()
        }
        let camera = UIAction(
            title: String.localized("Camera"),
            image: UIImage(systemName: "camera"),
            identifier: UIAction.Identifier("media.camera"),
            attributes: UIImagePickerController.isSourceTypeAvailable(.camera) ? [] : [.disabled]
        ) { [weak self] _ in
            self?.delegate?.onInputEditorCaptureButtonTapped()
        }
        bossButton.menu = UIMenu(children: [photoLibrary, camera])
        addSubview(elementClipper)
        elementClipper.clipsToBounds = true
        elementClipper.addSubview(bossButton)
        textView.font = font
        textView.delegate = self
        textView.showsVerticalScrollIndicator = false
        textView.showsHorizontalScrollIndicator = false
        textView.alwaysBounceVertical = false
        textView.alwaysBounceHorizontal = false
        textView.textColor = .label
        textView.textAlignment = .natural
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineBreakMode = .byWordWrapping
        textView.textContainer.lineFragmentPadding = .zero
        textView.textContainer.maximumNumberOfLines = 0
        textView.clipsToBounds = true
        textView.isSelectable = true
        textView.isScrollEnabled = true
        textView.isEditable = true
        textView.onReturnKeyPressed = { [weak self] in
            guard let self else { return }
            textView.insertText("\n")
        }
        textView.onCommandReturnKeyPressed = { [weak self] in
            self?.sendButton.tapAction()
        }
        textView.onImagePasted = { [weak self] image in
            self?.delegate?.onInputEditorPastingImage(image: image)
        }
        elementClipper.addSubview(textView)
        placeholderLabel.text = String.localized("Type something...")
        placeholderLabel.font = font
        placeholderLabel.textColor = .placeholderText
        elementClipper.addSubview(placeholderLabel)
        voiceButton.tapAction = { [weak self] in
            self?.delegate?.onInputEditorMicButtonTapped()
        }
        elementClipper.addSubview(voiceButton)
        moreButton.tapAction = { [weak self] in
            self?.isControlPanelOpened.toggle()
            self?.setNeedsLayout()
            self?.delegate?.onInputEditorToggleMoreButtonTapped()
        }
        elementClipper.addSubview(moreButton)
        sendButton.tapAction = { [weak self] in
            guard let self, !isSubmitting else { return }
            delegate?.onInputEditorSubmitButtonTapped()
        }
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(sendButtonLongPressed(_:)))
        sendButton.addGestureRecognizer(longPress)
        elementClipper.addSubview(sendButton)
        submissionSpinner.isUserInteractionEnabled = false
        submissionSpinner.isAccessibilityElement = true
        submissionSpinner.accessibilityIdentifier = "composer.submitting"
        submissionSpinner.accessibilityLabel = String.localized("Sending…")
        elementClipper.addSubview(submissionSpinner)
        stopButton.tapAction = { [weak self] in
            self?.delegate?.onInputEditorStopButtonTapped()
        }
        stopButton.alpha = 0
        elementClipper.addSubview(stopButton)

        textView.accessibilityIdentifier = "composer.text"
        sendButton.accessibilityIdentifier = "composer.send"
        sendButton.accessibilityLabel = String.localized("Send")
        stopButton.accessibilityIdentifier = "composer.stop"
        stopButton.accessibilityLabel = String.localized("Stop")
        voiceButton.accessibilityIdentifier = "composer.mic"
        voiceButton.accessibilityLabel = String.localized("Dictate")
        moreButton.accessibilityIdentifier = "composer.more"
        moreButton.accessibilityLabel = String.localized("Attach")
        bossButton.accessibilityIdentifier = "composer.media"
        bossButton.accessibilityLabel = String.localized("Add Image")

        textHeight.removeDuplicates()
            .compactMap { [weak self] textHeight -> CGFloat? in
                guard let self else { return nil }
                return max(textLayoutHeight(textHeight), iconSize.height)
                    + inset.top + inset.bottom
            }
            .ensureMainThread()
            .sink { [weak self] height in self?.heightPublisher.send(height) }
            .store(in: &cancellables)
        updateTextHeight()
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let previousTextWidth = textView.bounds.width
        elementClipper.frame = bounds

        switch isSubmitting ? .editingText : layoutStatus {
        case .standard:
            layoutAsStandard()
        case .preFocusText:
            layoutAsPreEditingText()
        case .editingText:
            layoutAsEditingText()
        }

        if textView.bounds.width != previousTextWidth { updateTextHeight() }
        updatePlaceholderAlpha()
        layoutStopButton()
        submissionSpinner.center = sendButton.center
        if isSubmitting { sendButton.alpha = 0 }
    }

    /// The stop control takes the more/mic slot while a run is active, so send and stop can
    /// coexist once there is text to send.
    private func layoutStopButton() {
        guard isRunning else {
            stopButton.alpha = 0
            return
        }
        switch isSubmitting ? .editingText : layoutStatus {
        case .standard, .preFocusText:
            stopButton.frame = moreButton.frame
            moreButton.alpha = 0
        case .editingText:
            stopButton.frame = voiceButton.frame
            voiceButton.alpha = 0
        }
        stopButton.alpha = 1
        stopButton.transform = .identity
    }

    @objc private func sendButtonLongPressed(_ recognizer: UILongPressGestureRecognizer) {
        guard !isSubmitting, recognizer.state == .began, sendButton.alpha > 0 else { return }
        delegate?.onInputEditorSubmitLongPressed()
    }

    func set(text: String) {
        textView.text = text
        updatePlaceholderAlpha()
        switchToRequiredStatus()
        updateTextHeight()
    }
}
