import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
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

  return {
    read(): SettingsConfig {
      if (!existsSync(settingsPath)) {
        return DEFAULT_SETTINGS_CONFIG
      }

      return parseSettingsToml(readFileSync(settingsPath, 'utf8'))
    },
    write(settings: SettingsConfig): void {
      writeFileSync(settingsPath, stringifySettingsToml(normalizeSettingsConfig(settings)), 'utf8')
    }
  }
}
