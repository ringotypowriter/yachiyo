import Foundation
import YachiyoRemoteKit

/// Local copies of images sent from this phone. Every read, write and removal runs on one
/// serial queue off the main thread, so a preview saved by one screen is visible to the next
/// screen's load and a removal cannot overtake an earlier save.
enum SentImages {
    static let store = RemoteSentImageStore(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteSentImages", isDirectory: true))
    static let queue = DispatchQueue(label: "sh.ringo.yachiyo.remote.sent-images", qos: .userInitiated)
}
