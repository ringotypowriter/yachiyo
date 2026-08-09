import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBehaviorSettingVisibility } from './settingsPlatform.ts'

test('Windows Behavior settings hide unsupported launch-at-login and keep-awake rows', () => {
  assert.deepEqual(resolveBehaviorSettingVisibility('win32'), {
    launchAtLogin: false,
    keepAwake: false
  })
})

test('macOS Behavior settings preserve launch-at-login and keep-awake rows', () => {
  assert.deepEqual(resolveBehaviorSettingVisibility('darwin'), {
    launchAtLogin: true,
    keepAwake: true
  })
})
