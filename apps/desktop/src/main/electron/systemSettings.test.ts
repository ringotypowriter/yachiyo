import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveNotificationSettingsUri } from './systemSettings.ts'

test('notification settings URI follows the host platform', () => {
  assert.equal(
    resolveNotificationSettingsUri('darwin'),
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
  )
  assert.equal(resolveNotificationSettingsUri('win32'), 'ms-settings:notifications')
  assert.equal(resolveNotificationSettingsUri('linux'), undefined)
})
