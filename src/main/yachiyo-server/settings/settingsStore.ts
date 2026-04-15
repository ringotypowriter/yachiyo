import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import {
  createPresetProviders,
  mergePresetProviders
} from '../../../shared/yachiyo/providerPresets.ts'
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

export interface SettingsStoreOptions {
  /** Seed preset providers on first launch when no config file exists. */
  seedPresetProviders?: boolean
}

export function createSettingsStore(
  settingsPath: string,
  options?: SettingsStoreOptions
): SettingsStore {
  mkdirSync(dirname(settingsPath), { recursive: true })

  if (options?.seedPresetProviders) {
    if (!existsSync(settingsPath)) {
      // First launch: seed all preset providers.
      const seeded: SettingsConfig = {
        ...DEFAULT_SETTINGS_CONFIG,
        providers: createPresetProviders()
      }
      writeFileSync(settingsPath, stringifySettingsToml(normalizeSettingsConfig(seeded)), 'utf8')
    } else {
      // Subsequent launches: backfill presetKey on legacy entries and merge missing presets.
      const config = parseSettingsToml(readFileSync(settingsPath, 'utf8'))
      const merged = mergePresetProviders(config.providers)
      config.providers = merged
      writeFileSync(settingsPath, stringifySettingsToml(normalizeSettingsConfig(config)), 'utf8')
    }
  }

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
