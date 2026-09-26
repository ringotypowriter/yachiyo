//
//  ChatInputView+Object.swift
//  LanguageModelChatUI
//

import Foundation
import UIKit

extension ChatInputView {
    public func collectObject() -> ChatInputContent {
        var text = (inputEditor.textView.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = attachmentsBar.attachments.values
        if text.isEmpty, !attachments.isEmpty {
            text = String.localized("Attached \(attachments.count) Documents")
        }
        return ChatInputContent(
            text: text,
            attachments: .init(attachments),
            options: [
                "storagePrefix": .url(storage.storageDir),
            ]
        )
    }

    func resetValues(keepingFocus: Bool = false) {
        inputEditor.set(text: "")
        if !keepingFocus { inputEditor.endEditing(true) }
        attachmentsBar.attachments.removeAll()
        controlPanel.close()
        inputEditor.isControlPanelOpened = false
        setNeedsLayout()
        publishNewEditorStatus()
    }

    /// Submits the current content with extra options, e.g. an explicit send mode (Yachiyo fork).
    public func submit(options: [String: ChatInputOptionValue]) {
        submitValues(extraOptions: options)
    }

    func submitValues(extraOptions: [String: ChatInputOptionValue] = [:]) {
        guard !isSubmitting, let delegate else { return }
        var object = collectObject()
        object.options.merge(extraOptions) { $1 }
        guard !object.hasEmptyContent else { return }

        let submissionID = UUID()
        let submittedText = inputEditor.textView.text ?? ""
        let submittedAttachments = Array(attachmentsBar.attachments.values)
        pendingSubmissionID = submissionID
        inputEditor.isSubmitting = true
        publishNewEditorStatus()

        let completion: @Sendable (Bool) -> Void = { [weak self] success in
            Task { @MainActor [weak self] in
                guard let self, self.pendingSubmissionID == submissionID else { return }
                self.invalidateSubmission()
                guard success else { return }
                // Never replace edits made while the delegate was uploading or awaiting ACK.
                guard self.inputEditor.textView.text == submittedText,
                      Array(self.attachmentsBar.attachments.values) == submittedAttachments else { return }
                self.resetValues(keepingFocus: true)
                // Do not remove the shared directory: another import or upload may still
                // reference it. Temporary assets remain available for the OS temp lifecycle.
            }
        }
        delegate.chatInputDidSubmit(self, object: object, completion: completion)
    }

    static let editorStatusPublishDelay: TimeInterval = 0.3

    func scheduleEditorStatusPublish() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(flushScheduledEditorStatus), object: nil)
        hasScheduledEditorStatusPublish = true
        perform(#selector(flushScheduledEditorStatus), with: nil, afterDelay: Self.editorStatusPublishDelay)
    }

    @objc func flushScheduledEditorStatus() {
        guard hasScheduledEditorStatusPublish else { return }
        publishNewEditorStatus()
    }

    func publishNewEditorStatus() {
        assert(Thread.isMainThread)
        guard !objectTransactionInProgress else { return }
        if hasScheduledEditorStatusPublish {
            hasScheduledEditorStatusPublish = false
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(flushScheduledEditorStatus), object: nil)
        }
        var object = collectObject()
        // Drafts retain whitespace and attachment-only input without the send-time fallback text.
        object.text = inputEditor.textView.text ?? ""
        objectTransactionInProgress = true
        defer { objectTransactionInProgress = false }
        delegate?.chatInputDidUpdateObject(self, object: object)
    }

    func restoreEditorStatusIfPossible() {
        assert(Thread.isMainThread)
        guard let object = delegate?.chatInputDidRequestObjectForRestore(self) else { return }
        objectTransactionInProgress = true
        defer { objectTransactionInProgress = false }
        resetValues()
        inputEditor.set(text: object.text)
        attachmentsBar.attachments.removeAll()
        for attachment in object.attachments {
            attachmentsBar.insert(item: attachment)
        }
    }

    public func refill(withText text: String, attachments: [ChatInputAttachment]) {
        inputEditor.set(text: text)
        attachmentsBar.attachments.removeAll()
        for attachment in attachments {
            attachmentsBar.insert(item: attachment)
        }
    }
}
