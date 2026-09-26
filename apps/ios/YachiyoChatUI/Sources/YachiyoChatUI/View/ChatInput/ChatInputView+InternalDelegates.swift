//
//  ChatInputView+InternalDelegates.swift
//  LanguageModelChatUI
//

import Foundation
import PDFKit
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// MARK: - InputEditor.Delegate

extension ChatInputView: InputEditor.Delegate {
    func onInputEditorCaptureButtonTapped() {
        openCamera()
    }

    func onInputEditorPickPhotoButtonTapped() {
        openPhotoPicker()
    }

    func onInputEditorPickAttachmentTapped() {
        openFilePicker()
    }

    func onInputEditorMicButtonTapped() {
        presentSpeechRecognition()
    }

    func onInputEditorToggleMoreButtonTapped() {
        endEditing(true)
        controlPanel.toggle()
    }

    func onInputEditorPasteAsAttachmentTapped() {
        guard importPasteboardContentAsAttachment() else {
            delegate?.chatInputDidReportError(self, error: String.localized("Unsupported format."))
            return
        }
    }

    func onInputEditorSubmitButtonTapped() {
        submitValues()
    }

    func onInputEditorStopButtonTapped() {
        delegate?.chatInputDidRequestStop(self)
    }

    func onInputEditorSubmitLongPressed() {
        delegate?.chatInputDidRequestAlternateSubmit(self)
    }

    func onInputEditorBeginEditing() {
        controlPanel.close()
    }

    func onInputEditorEndEditing() {
        publishNewEditorStatus()
    }

    func onInputEditorPastingLargeTextAsDocument(content: String) {
        insertTextAttachment(content: content, preferredName: nil)
    }

    func onInputEditorPastingImage(image: UIImage) {
        process(image: image)
    }

    func onInputEditorTextChanged(text: String) {
        dropColorView.alpha = 0
        // Drafts only need to survive leaving the thread; coalesce keystrokes. Ending editing,
        // resigning active, leaving the window and submitting all publish immediately.
        scheduleEditorStatusPublish()
        guard text.isEmpty else { return }
        controlPanel.close()
    }
}

// MARK: - AttachmentsBar.Delegate

extension ChatInputView: AttachmentsBar.Delegate {
    func attachmentBarDidUpdateAttachments(_ attachments: [AttachmentsBar.Item]) {
        inputEditor.hasAttachments = !attachments.isEmpty
        publishNewEditorStatus()
    }
}

// MARK: - QuickSettingBar.Delegate

extension ChatInputView: QuickSettingBar.Delegate {
    func quickSettingBarOnValueChanged() {
        publishNewEditorStatus()
    }
}

// MARK: - ControlPanel.Delegate

extension ChatInputView: ControlPanel.Delegate {
    func onControlPanelOpen() {
        quickSettingBar.hide()
        inputEditor.isControlPanelOpened = true
    }

    func onControlPanelClose() {
        quickSettingBar.show()
        inputEditor.isControlPanelOpened = false
    }

    func onControlPanelCameraButtonTapped() {
        openCamera()
    }

    func onControlPanelPickPhotoButtonTapped() {
        openPhotoPicker()
    }

    func onControlPanelPickFileButtonTapped() {
        openFilePicker()
    }

    func onControlPanelRequestWebScrubber() {}
}

// MARK: - Speech Recognition

extension ChatInputView {
    func presentSpeechRecognition() {
        guard parentViewController?.presentedViewController == nil else { return }
        let controller = SimpleSpeechController()
        controller.callback = { [weak self] text in
            self?.inputEditor.set(
                text: (self?.inputEditor.textView.text ?? "") + text
            )
            self?.inputEditor.textView.becomeFirstResponder()
        }
        controller.onErrorCallback = { [weak self, weak controller] error in
            guard let self else { return }
            let report = {
                self.delegate?.chatInputDidReportError(self, error: error.localizedDescription)
            }
            if let controller, controller.presentingViewController != nil {
                controller.dismiss(animated: true) {
                    report()
                }
            } else {
                report()
            }
        }
        parentViewController?.present(controller, animated: true)
    }
}

// MARK: - Camera / Photo / File Pickers

extension ChatInputView {
    func openCamera() {
        guard let parent = parentViewController, parent.presentedViewController == nil else { return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            delegate?.chatInputDidReportError(self, error: String.localized("Camera is not available on this device."))
            return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        picker.allowsEditing = false
        picker.mediaTypes = ["public.image"]
        parent.present(picker, animated: true)
    }

    func openPhotoPicker() {
        guard let parent = parentViewController, parent.presentedViewController == nil else { return }
        var config = PHPickerConfiguration()
        config.selectionLimit = 4
        config.filter = .images
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        parent.present(picker, animated: true)
    }

    func openFilePicker() {
        guard let parent = parentViewController, parent.presentedViewController == nil else { return }
        let supportedTypes: [UTType] = [.data, .image, .text, .plainText, .pdf, .audio]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: supportedTypes)
        picker.delegate = self
        picker.allowsMultipleSelection = true
        parent.present(picker, animated: true)
    }
}

// MARK: - File Processing

extension ChatInputView {
    func process(image: UIImage) {
        let compress = configuration.compressImage
        let storageFilename = storage.makeUniqueFilenameStem() + ".jpeg"
        let destinationURL = storage.fileURL(for: storageFilename)
        Task { [weak self] in
            let prepared = await ChatInputView.prepareImageAttachment(image, compress: compress, destination: destinationURL)
            guard let self else { return }
            insertPreparedImage(prepared, storageFilename: storageFilename)
        }
    }

    private struct PreparedImage: Sendable {
        let fileData: Data
        let previewData: Data
    }

    private func insertPreparedImage(_ prepared: PreparedImage?, storageFilename: String) {
        guard let prepared else {
            delegate?.chatInputDidReportError(self, error: String.localized("Failed to process image."))
            return
        }
        attachmentsBar.insert(item: ChatInputAttachment(
            type: .image,
            name: String.localized("Image"),
            previewImageData: prepared.previewData,
            fileData: prepared.fileData,
            storageFilename: storageFilename
        ))
    }

    /// Resize, JPEG encode, EXIF strip, write and preview, all off the main actor. The preview is
    /// an ImageIO thumbnail of the encoded file, not a second full-resolution JPEG.
    private nonisolated static func prepareImageAttachment(
        _ image: UIImage,
        compress: Bool,
        destination: URL
    ) async -> PreparedImage? {
        await Task.detached(priority: .userInitiated) {
            guard let compressed = image.prepareAttachment(compressImage: compress) else { return nil }
            do {
                try FileManager.default.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? FileManager.default.removeItem(at: destination)
                try compressed.write(to: destination)
            } catch {
                return nil
            }
            let preview = ImageDownsampler.previewJPEG(
                from: compressed,
                filling: AttachmentsBar.imageItemSize,
                scale: 3
            ) ?? compressed
            return PreparedImage(fileData: compressed, previewData: preview)
        }.value
    }

    func process(file: URL) {
        if let fileType = UTType(filenameExtension: file.pathExtension),
           fileType.conforms(to: .audio)
        {
            processAudioFile(file)
            return
        }

        if let image = UIImage(contentsOfFile: file.path) {
            process(image: image)
            return
        }

        if file.pathExtension.lowercased() == "pdf" {
            processPDF(file: file)
            return
        }

        guard let attachment = makeTextAttachment(file: file) else {
            delegate?.chatInputDidReportError(self, error: String.localized("Unsupported format."))
            return
        }
        if attachment.textContent.count > 1_000_000 {
            delegate?.chatInputDidReportError(self, error: String.localized("Text too long."))
            return
        }
        attachmentsBar.insert(item: attachment)
    }

    private func processAudioFile(_ url: URL) {
        guard let storedAudioURL = storage.copyFileIntoStorageIfNeeded(url) else {
            delegate?.chatInputDidReportError(self, error: String.localized("Failed to process audio file."))
            return
        }
        let storageFilename = storedAudioURL.lastPathComponent
        let fileExtension = url.pathExtension.isEmpty ? "m4a" : url.pathExtension
        let name = url.lastPathComponent.isEmpty ? "Audio.\(fileExtension)" : url.lastPathComponent

        let attachment = ChatInputAttachment(
            type: .audio,
            name: name,
            fileData: (try? Data(contentsOf: storedAudioURL)) ?? Data(),
            textContent: name,
            storageFilename: storageFilename
        )
        attachmentsBar.insert(item: attachment)
    }

    func processPDF(file: URL) {
        guard let pdfDocument = PDFDocument(url: file) else {
            delegate?.chatInputDidReportError(self, error: String.localized("Failed to load PDF file."))
            return
        }

        let pageCount = pdfDocument.pageCount
        guard pageCount > 0 else {
            delegate?.chatInputDidReportError(self, error: String.localized("PDF file is empty."))
            return
        }

        let alert = UIAlertController(
            title: String.localized("Import PDF"),
            message: String.localized("This PDF has \(pageCount) page(s). Import as text or convert to images?"),
            preferredStyle: .actionSheet
        )
        alert.addAction(UIAlertAction(title: String.localized("Import Text"), style: .default) { [weak self] _ in
            Task { [weak self] in
                // Text extraction walks every page; keep it off the main actor.
                let text = await Task.detached(priority: .userInitiated) { pdfDocument.string ?? "" }.value
                guard let self else { return }
                if text.count > 1_000_000 {
                    delegate?.chatInputDidReportError(self, error: String.localized("Text too long."))
                    return
                }
                attachmentsBar.insert(item: ChatInputAttachment(
                    type: .document,
                    name: file.lastPathComponent,
                    textContent: text,
                    storageFilename: file.lastPathComponent
                ))
            }
        })
        alert.addAction(UIAlertAction(title: String.localized("Convert to Images"), style: .default) { [weak self] _ in
            self?.convertPDFToImages(pdfDocument: pdfDocument)
        })
        alert.addAction(UIAlertAction(title: String.localized("Cancel"), style: .cancel))

        if let popover = alert.popoverPresentationController {
            popover.sourceView = self
            popover.sourceRect = bounds
        }
        parentViewController?.present(alert, animated: true)
    }

    /// Longest page side, in pixels, for PDF page images. Attachments are resized further (to
    /// 1024) when compression is on; this bound only keeps huge media boxes from exhausting memory.
    nonisolated static let maximumPDFPagePixelSize: CGFloat = 2048

    /// Renders pages one at a time off the main actor, inserting each page as it is ready, so
    /// neither the rendering nor every full-size page image stays on the main actor or in memory.
    func convertPDFToImages(pdfDocument: PDFDocument) {
        let pageCount = pdfDocument.pageCount
        let compress = configuration.compressImage
        let destinations = (0 ..< pageCount).map { _ -> (String, URL) in
            let filename = storage.makeUniqueFilenameStem() + ".jpeg"
            return (filename, storage.fileURL(for: filename))
        }
        Task { [weak self] in
            for index in 0 ..< pageCount {
                let (filename, destination) = destinations[index]
                let prepared: PreparedImage? = await Task.detached(priority: .userInitiated) {
                    guard let page = pdfDocument.page(at: index),
                          let image = ChatInputView.renderPage(page)
                    else { return nil }
                    return await ChatInputView.prepareImageAttachment(image, compress: compress, destination: destination)
                }.value
                guard let self else { return }
                insertPreparedImage(prepared, storageFilename: filename)
            }
        }
    }

    private nonisolated static func renderPage(_ page: PDFPage) -> UIImage? {
        let rect = page.bounds(for: .mediaBox)
        guard rect.width > 0, rect.height > 0 else { return nil }
        let scale = min(1, maximumPDFPagePixelSize / max(rect.width, rect.height))
        let size = CGSize(width: floor(rect.width * scale), height: floor(rect.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.set()
            context.fill(CGRect(origin: .zero, size: size))
            context.cgContext.translateBy(x: 0, y: size.height)
            context.cgContext.scaleBy(x: scale, y: -scale)
            context.cgContext.translateBy(x: -rect.minX, y: -rect.minY)
            page.draw(with: .mediaBox, to: context.cgContext)
        }
    }

    private func makeTextAttachment(file: URL) -> ChatInputAttachment? {
        guard let storedFileURL = storage.copyFileIntoStorageIfNeeded(file) else { return nil }
        guard let content = try? String(contentsOf: file) else { return nil }
        return ChatInputAttachment(
            type: .document,
            name: file.lastPathComponent,
            textContent: content,
            storageFilename: storedFileURL.lastPathComponent
        )
    }
}

// MARK: - Pasteboard

private extension ChatInputView {
    func importPasteboardContentAsAttachment() -> Bool {
        let pasteboard = UIPasteboard.general

        if pasteboard.hasImages, let image = pasteboard.image {
            process(image: image)
            return true
        }

        if let fileURL = extractFileURL(from: pasteboard) {
            process(file: fileURL)
            return true
        }

        if let remoteURL = extractRemoteURL(from: pasteboard) {
            let preferredName = suggestedName(for: remoteURL)
            insertTextAttachment(content: remoteURL.absoluteString, preferredName: preferredName)
            return true
        }

        if let text = extractText(from: pasteboard) {
            insertTextAttachment(content: text, preferredName: nil)
            return true
        }

        return false
    }

    func extractFileURL(from pasteboard: UIPasteboard) -> URL? {
        if let url = pasteboard.url, url.isFileURL { return url }
        if let urls = pasteboard.urls, let fileURL = urls.first(where: { $0.isFileURL }) { return fileURL }
        for item in pasteboard.items {
            if let url = item[UTType.fileURL.identifier] as? URL { return url }
            if let data = item[UTType.fileURL.identifier] as? Data,
               let urlString = String(data: data, encoding: .utf8),
               let url = URL(string: urlString), url.isFileURL { return url }
        }
        return nil
    }

    func extractRemoteURL(from pasteboard: UIPasteboard) -> URL? {
        if let url = pasteboard.url, !url.isFileURL { return url }
        if let urls = pasteboard.urls, let remote = urls.first(where: { !$0.isFileURL }) { return remote }
        for item in pasteboard.items {
            if let url = item[UTType.url.identifier] as? URL, !url.isFileURL { return url }
            if let data = item[UTType.url.identifier] as? Data,
               let urlString = String(data: data, encoding: .utf8),
               let url = URL(string: urlString), !url.isFileURL { return url }
        }
        return nil
    }

    func extractText(from pasteboard: UIPasteboard) -> String? {
        if let string = pasteboard.string, !string.isEmpty { return string }
        for item in pasteboard.items {
            for (typeIdentifier, value) in item {
                guard let type = UTType(typeIdentifier), type.conforms(to: .plainText) else { continue }
                if let string = value as? String, !string.isEmpty { return string }
                if let data = value as? Data, let string = String(data: data, encoding: .utf8), !string.isEmpty { return string }
            }
        }
        return nil
    }

    func insertTextAttachment(content: String, preferredName: String?) {
        guard !content.isEmpty else { return }
        let sanitizedName = sanitizedFileName(from: preferredName)
        let destinationURL = storage.fileURL(for: storage.makeUniqueFilenameStem())
            .deletingLastPathComponent()
            .appendingPathComponent(sanitizedName)
            .appendingPathExtension("txt")
        do {
            try content.write(to: destinationURL, atomically: true, encoding: .utf8)
            process(file: destinationURL)
        } catch {
            delegate?.chatInputDidReportError(self, error: String.localized("Failed to save text."))
        }
    }

    func sanitizedFileName(from preferredName: String?) -> String {
        let fallback = String.localized("Pasteboard") + "-\(UUID().uuidString)"
        guard var name = preferredName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return fallback
        }
        let invalidCharacters = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        let components = name.components(separatedBy: invalidCharacters).filter { !$0.isEmpty }
        name = components.isEmpty ? fallback : components.joined(separator: "-")
        return name
    }

    func suggestedName(for url: URL) -> String? {
        let lastComponent = url.lastPathComponent
        if !lastComponent.isEmpty { return lastComponent }
        if let host = url.host, !host.isEmpty { return host }
        return nil
    }
}
