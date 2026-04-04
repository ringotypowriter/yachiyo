import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { createPresetProviders } from '../../../shared/yachiyo/providerPresets.ts'
import {
  DEFAULT_SETTINGS_CONFIG,
  normalizeSettingsConfig,
  toEffectiveProviderSettings,
  toProviderSettings,
  toToolModelSettings
} from './settingsConfig.ts'
import { parseSettingsToml, stringifySettingsToml } from './settingsTomlCodec.ts'

export {
  DEFAULT_SETTINGS_CONFIG,
  normalizeSettingsConfig,
  parseSettingsToml,
  stringifySettingsToml,
  toEffectiveProviderSettings,
  toProviderSettings,
  toToolModelSettings
}

export interface SettingsStore {
  read: () => SettingsConfig
  write: (settings: SettingsConfig) => void
}

export function createSettingsStore(settingsPath: string): SettingsStore {
  mkdirSync(dirname(settingsPath), { recursive: true })

  // Seed preset providers on genuine first launch (no config file yet).
  // Once written, subsequent reads go through the TOML path and respect
  // user changes including provider removals.
  const isFirstLaunch = !existsSync(settingsPath)
  if (isFirstLaunch) {
    const seeded: SettingsConfig = {
      ...DEFAULT_SETTINGS_CONFIG,
      providers: createPresetProviders()
    }
    writeFileSync(settingsPath, stringifySettingsToml(normalizeSettingsConfig(seeded)), 'utf8')
  }

  return {
    read(): SettingsConfig {
      return parseSettingsToml(readFileSync(settingsPath, 'utf8'))
    },
    write(settings: SettingsConfig): void {
      writeFileSync(settingsPath, stringifySettingsToml(normalizeSettingsConfig(settings)), 'utf8')
    }
  }
}
