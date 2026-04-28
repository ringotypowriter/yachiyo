import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { resolveActivityTrackingPermissionForSave } from './activityTrackingPermission.ts'

function baseConfig(mode: 'off' | 'simple' | 'full'): SettingsConfig {
  return {
    providers: [],
    general: {
      activityTracking: { mode }
    }
  }
}

test('resolveActivityTrackingPermissionForSave keeps Full only when the full sampler is available', async () => {
  const result = await resolveActivityTrackingPermissionForSave(
    {
      ...baseConfig('simple'),
      general: {
        demoMode: true,
        activityTracking: { mode: 'full', accessibilityDenied: true }
      }
    },
    baseConfig('simple'),
    {
      platform: 'darwin',
      requestAccessibilityTrust: () => true,
      probeFullActivityAccess: async () => true
    }
  )

  assert.deepEqual(result.general?.activityTracking, { mode: 'full' })
  assert.equal(result.general?.demoMode, true)
})

test('resolveActivityTrackingPermissionForSave denies Full without permission and preserves the previous allowed mode', async () => {
  const result = await resolveActivityTrackingPermissionForSave(
    baseConfig('full'),
    baseConfig('simple'),
    {
      platform: 'darwin',
      requestAccessibilityTrust: () => false,
      probeFullActivityAccess: async () => {
        throw new Error('should not probe when Electron is not trusted')
      }
    }
  )

  assert.deepEqual(result.general?.activityTracking, {
    mode: 'simple',
    accessibilityDenied: true
  })
})

test('resolveActivityTrackingPermissionForSave denies Full back to Off when Off was the previous mode', async () => {
  const result = await resolveActivityTrackingPermissionForSave(
    baseConfig('full'),
    baseConfig('off'),
    {
      platform: 'darwin',
      requestAccessibilityTrust: () => false,
      probeFullActivityAccess: async () => false
    }
  )

  assert.deepEqual(result.general?.activityTracking, {
    mode: 'off',
    accessibilityDenied: true
  })
})

test('resolveActivityTrackingPermissionForSave leaves non-Full requests unchanged', async () => {
  const input = {
    ...baseConfig('simple'),
    general: {
      activityTracking: { mode: 'off' as const }
    }
  }
  const result = await resolveActivityTrackingPermissionForSave(input, baseConfig('simple'), {
    platform: 'darwin',
    requestAccessibilityTrust: () => {
      throw new Error('should not request permission for non-Full modes')
    },
    probeFullActivityAccess: async () => false
  })

  assert.equal(result, input)
})
