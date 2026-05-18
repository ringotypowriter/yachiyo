import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS_CONFIG } from '../../../settings/settingsStore.ts'
import type { SettingsConfig } from '../../../../../shared/yachiyo/protocol.ts'
import { YachiyoServerConfigDomain } from './configDomain.ts'

test('saveToolPreferences preserves custom enabled tools when no run mode is supplied', () => {
  let config: SettingsConfig = {
    ...DEFAULT_SETTINGS_CONFIG,
    enabledTools: ['read', 'bash'],
    runMode: 'auto'
  }
  const domain = new YachiyoServerConfigDomain({
    settingsStore: {
      read: () => config,
      write: (nextConfig) => {
        config = nextConfig
      }
    },
    emit: () => {}
  })

  const nextConfig = domain.saveToolPreferences({ enabledTools: ['read', 'edit'] })

  assert.deepEqual(nextConfig.enabledTools, ['read', 'edit'])
  assert.equal(nextConfig.runMode, 'custom')
})
