//
//  ImageDownsampler.swift
//  YachiyoChatUI
//
//  Thumbnails decoded straight to display size with ImageIO, so an 80 pt preview never decodes a
//  full-resolution photo, and never on the main thread.
//

import ImageIO
import UIKit
import UniformTypeIdentifiers

enum ImageDownsampler {
    /// A thumbnail that fills `pointSize` (aspect-fill) at `scale`, with EXIF orientation applied.
    static func thumbnail(from data: Data, filling pointSize: CGSize, scale: CGFloat) -> CGImage? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options) else { return nil }
        return thumbnail(from: source, maxPixelSize: fillingPixelSize(of: source, pointSize: pointSize, scale: scale))
    }

    static func thumbnail(from data: Data, maxPixelSize: CGFloat) -> CGImage? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options) else { return nil }
        return thumbnail(from: source, maxPixelSize: maxPixelSize)
    }

    /// A small JPEG for `ChatInputAttachment.previewImageData`.
    static func previewJPEG(from data: Data, filling pointSize: CGSize, scale: CGFloat) -> Data? {
        guard let image = thumbnail(from: data, filling: pointSize, scale: scale) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }

    private static func thumbnail(from source: CGImageSource, maxPixelSize: CGFloat) -> CGImage? {
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, Int(maxPixelSize.rounded(.up))),
        ] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
    }

    /// The longest-side pixel size whose shorter side still covers `pointSize` once aspect-filled.
    private static func fillingPixelSize(of source: CGImageSource, pointSize: CGSize, scale: CGFloat) -> CGFloat {
        let target = max(pointSize.width, pointSize.height) * scale
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0
        else { return target }
        // Panoramas would otherwise request a near-full decode; cap the stretch at 4:1.
        let aspect = min(4, max(width, height) / min(width, height))
        return target * CGFloat(aspect)
    }
}

/// Decoded attachment thumbnails by attachment id and data size.
@MainActor
final class AttachmentThumbnailCache {
    static let shared = AttachmentThumbnailCache()

    private let images = NSCache<NSString, UIImage>()
    private var waiters: [NSString: [(UIImage?) -> Void]] = [:]

    init() {
        images.countLimit = 200
    }

    static func key(id: UUID, data: Data, pointSize: CGSize, scale: CGFloat) -> NSString {
        "\(id.uuidString)/\(data.count)/\(Int(pointSize.width))x\(Int(pointSize.height))@\(scale)" as NSString
    }

    func cachedImage(for key: NSString) -> UIImage? {
        images.object(forKey: key)
    }

    /// Decodes off the main thread; `completion` runs on the main thread.
    func loadImage(
        for key: NSString,
        data: Data,
        pointSize: CGSize,
        scale: CGFloat,
        completion: @escaping (UIImage?) -> Void
    ) {
        if let image = images.object(forKey: key) {
            completion(image)
            return
        }
        if waiters[key] != nil {
            waiters[key]?.append(completion)
            return
        }
        waiters[key] = [completion]
        Task.detached(priority: .userInitiated) { [self] in
            let image = ImageDownsampler.thumbnail(from: data, filling: pointSize, scale: scale)
                .map { UIImage(cgImage: $0, scale: scale, orientation: .up) }
            await MainActor.run {
                if let image { images.setObject(image, forKey: key) }
                for callback in waiters.removeValue(forKey: key) ?? [] { callback(image) }
            }
        }
    }
}
