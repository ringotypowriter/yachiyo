export function resolveNotificationSettingsUri(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') {
    return 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
  }
  if (platform === 'win32') return 'ms-settings:notifications'
  return undefined
}
