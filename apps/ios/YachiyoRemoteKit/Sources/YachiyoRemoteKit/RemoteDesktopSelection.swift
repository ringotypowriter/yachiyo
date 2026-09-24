/// Resolves a single paired desktop without considering connection state.
/// A disconnected desktop stays selected; only forgetting it triggers a fallback.
public enum RemoteDesktopSelection {
    public static func resolve(savedId: String?, desktopIds: [String], primaryId: String?) -> String? {
        if let savedId, desktopIds.contains(savedId) { return savedId }
        if let primaryId, desktopIds.contains(primaryId) { return primaryId }
        return desktopIds.first
    }
}
