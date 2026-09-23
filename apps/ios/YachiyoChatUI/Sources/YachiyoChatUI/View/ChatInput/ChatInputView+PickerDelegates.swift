//
//  ChatInputView+PickerDelegates.swift
//  LanguageModelChatUI
//

import PhotosUI
import UIKit

extension ChatInputView: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    public func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage else { return }
        process(image: image)
    }

    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }
}

extension ChatInputView: PHPickerViewControllerDelegate {
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        for result in results {
            result.itemProvider.loadObject(ofClass: UIImage.self) { [weak self] reading, _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard let image = reading as? UIImage else {
                        delegate?.chatInputDidReportError(self, error: String.localized("Could not load the selected photo. Please try again."))
                        return
                    }
                    process(image: image)
                }
            }
        }
    }
}

extension ChatInputView: UIDocumentPickerDelegate {
    public func documentPicker(_: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        for url in urls {
            let hasAccess = url.startAccessingSecurityScopedResource()
            defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
            process(file: url)
        }
    }
}
