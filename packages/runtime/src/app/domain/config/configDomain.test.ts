import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS_CONFIG } from '../../../settings/settingsStore.ts'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { YachiyoServerConfigDomain } from './configDomain.ts'

test('saveToolPreferences ignores deprecated global tool preferences', () => {
  let config: SettingsConfig = {
    ...DEFAULT_SETTINGS_CONFIG,
    providers: []
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

  const nextConfig = domain.saveToolPreferences({ enabledTools: ['read', 'edit'], runMode: 'chat' })

  assert.deepEqual(nextConfig, config)
  assert.equal(nextConfig.enabledTools, undefined)
  assert.equal(nextConfig.runMode, undefined)
})
