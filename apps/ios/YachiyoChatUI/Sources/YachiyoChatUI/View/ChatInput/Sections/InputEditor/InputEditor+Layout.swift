//
//  InputEditor+Layout.swift
//  LanguageModelChatUI
//

import UIKit

extension InputEditor {
    func textLayoutHeight(_ input: CGFloat) -> CGFloat {
        var finalHeight = input
        finalHeight = max(font.lineHeight, finalHeight)
        finalHeight = min(finalHeight, maxTextEditorHeight)
        return ceil(finalHeight)
    }

    func switchToRequiredStatus() {
        assert(Thread.isMainThread)
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(switchToRequiredStatusEx), object: nil)
        perform(#selector(switchToRequiredStatusEx), with: nil, afterDelay: 0.1)
    }

    @objc private func switchToRequiredStatusEx() {
        doWithAnimation { [self] in
            moreButton.transform = .identity
            sendButton.transform = .identity
            voiceButton.transform = .identity
            if textView.isFirstResponder {
                if textView.text.isEmpty && !hasAttachments {
                    layoutStatus = .preFocusText
                } else {
                    layoutStatus = .editingText
                }
            } else {
                if textView.text.isEmpty && !hasAttachments {
                    layoutStatus = .standard
                } else {
                    layoutStatus = .editingText
                }
            }
        }
    }

    func layoutAsEditingText() {
        sendButton.frame = CGRect(
            x: bounds.width - inset.right - iconSize.width,
            y: bounds.height - iconSize.height - inset.bottom,
            width: iconSize.width,
            height: iconSize.height
        )
        sendButton.alpha = 1
        moreButton.frame = CGRect(
            x: inset.left,
            y: bounds.height - iconSize.height - inset.bottom,
            width: iconSize.width,
            height: iconSize.height
        )
        moreButton.transform = .identity
        moreButton.alpha = 1
        voiceButton.frame = CGRect(
            x: sendButton.frame.minX - iconSize.width - iconSpacing,
            y: sendButton.frame.minY,
            width: iconSize.width,
            height: iconSize.height
        )
        // A draft uses the send slot; do not reserve another 44 points for dictation.
        // During a run the stop button still occupies the voice slot.
        voiceButton.alpha = 0

        let textLayoutHeight = textLayoutHeight(textHeight.value)
        textView.frame = CGRect(
            x: moreButton.frame.maxX + iconSpacing,
            y: (bounds.height - textLayoutHeight) / 2,
            width: (isRunning ? voiceButton.frame.minX : sendButton.frame.minX) - moreButton.frame.maxX - iconSpacing * 2,
            height: textLayoutHeight
        )
        placeholderLabel.frame = textView.frame
    }

    func layoutAsPreEditingText() {
        defer { sendButton.transform = CGAffineTransform(scaleX: 0.5, y: 0.5) }

        moreButton.frame = CGRect(
            x: inset.left,
            y: inset.top,
            width: iconSize.width,
            height: iconSize.height
        )
        moreButton.alpha = 1
        voiceButton.frame = CGRect(
            x: bounds.width - inset.right - iconSize.width,
            y: inset.top,
            width: iconSize.width,
            height: iconSize.height
        )
        voiceButton.alpha = 1
        let textLayoutHeight = textLayoutHeight(textHeight.value)
        textView.frame = CGRect(
            x: moreButton.frame.maxX + iconSpacing,
            y: (bounds.height - textLayoutHeight) / 2,
            width: voiceButton.frame.minX - moreButton.frame.maxX - iconSpacing * 2,
            height: textLayoutHeight
        )
        textView.alpha = 1
        placeholderLabel.frame = textView.frame

        sendButton.frame = CGRect(
            x: bounds.width + iconSpacing + inset.right,
            y: bounds.height - iconSize.height - inset.bottom,
            width: iconSize.width,
            height: iconSize.height
        )
        sendButton.alpha = 0
    }

    func layoutAsStandard() {
        layoutAsPreEditingText()
    }
}
