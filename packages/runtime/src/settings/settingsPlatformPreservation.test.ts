import assert from 'node:assert/strict'
import test from 'node:test'

import { preserveUnsupportedPlatformSettings } from './settingsPlatformPreservation.ts'

test('saving settings on Windows preserves synced macOS Activity configuration', () => {
  const previous = {
    providers: [],
    general: {
      activityTracking: {
        mode: 'full' as const,
        ocr: { enabled: true, excludedApps: ['Password Manager'] }
      }
    }
  }
  const submitted = {
    providers: [],
    general: {
      activityTracking: {
        mode: 'off' as const,
        ocr: { enabled: false }
      }
    }
  }

  const saved = preserveUnsupportedPlatformSettings({
    platform: 'win32',
    previous,
    submitted
  })

  assert.deepEqual(saved.general?.activityTracking, previous.general.activityTracking)
  assert.deepEqual(submitted.general.activityTracking, {
    mode: 'off',
    ocr: { enabled: false }
  })
})

test('saving settings on Windows preserves the unsupported keep-awake preference', () => {
  const previous = {
    providers: [],
    general: { preventSystemSleep: true }
  }
  const submitted = {
    providers: [],
    general: { preventSystemSleep: false }
  }

  const saved = preserveUnsupportedPlatformSettings({
    platform: 'win32',
    previous,
    submitted
  })

  assert.equal(saved.general?.preventSystemSleep, true)
  assert.equal(submitted.general.preventSystemSleep, false)
})

test('macOS settings save keeps the submitted Activity configuration', () => {
  const previous = {
    providers: [],
    general: { activityTracking: { mode: 'simple' as const } }
  }
  const submitted = {
    providers: [],
    general: { activityTracking: { mode: 'full' as const } }
  }

  assert.deepEqual(
    preserveUnsupportedPlatformSettings({ platform: 'darwin', previous, submitted }),
    submitted
  )
})
