import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SettingsConfig, ThreadModelOverride } from '@yachiyo/shared/protocol'
import { createPresetProviders, mergePresetProviders } from '@yachiyo/shared/providerPresets'
import {
  DEFAULT_SETTINGS_CONFIG,
  normalizeSettingsConfig,
  toEffectiveProviderSettings,
  toProviderSettings,
  toSubagentProviderSettings,
  toToolModelSettings
} from './settingsConfig.ts'
import { parseSettingsToml, stringifySettingsToml } from './settingsTomlCodec.ts'
import { parseChannelsToml } from '../runtime/config/channelsTomlCodec.ts'

export {
  DEFAULT_SETTINGS_CONFIG,
  normalizeSettingsConfig,
  parseSettingsToml,
  stringifySettingsToml,
  toEffectiveProviderSettings,
  toProviderSettings,
  toSubagentProviderSettings,
  toToolModelSettings
}

export interface SettingsStore {
  read: () => SettingsConfig
  /** Persists the settings. Returns false when the file content was already identical. */
  write: (settings: SettingsConfig) => boolean
}

export interface SettingsStoreOptions {
  /** Seed preset providers on first launch when no config file exists. */
  seedPresetProviders?: boolean
}

function readLegacyImageToTextModel(settingsPath: string): ThreadModelOverride | undefined {
  const channelsPath = join(dirname(settingsPath), 'channels.toml')
  if (!existsSync(channelsPath)) {
    return undefined
  }

  try {
    return (
      parseChannelsToml(readFileSync(channelsPath, 'utf8')).imageToText as
        | { model?: ThreadModelOverride }
        | undefined
    )?.model
  } catch {
    return undefined
  }
}

function migrateLegacyImageToTextModel(settingsPath: string): void {
  if (!existsSync(settingsPath)) {
    return
  }

  const config = parseSettingsToml(readFileSync(settingsPath, 'utf8'))
  if (config.chat?.imageToTextModel) {
    return
  }

  const imageToTextModel = readLegacyImageToTextModel(settingsPath)
  if (!imageToTextModel) {
    return
  }

  writeFileSync(
    settingsPath,
    stringifySettingsToml(
      normalizeSettingsConfig({
        ...config,
        chat: {
          ...config.chat,
          imageToTextModel
        }
      })
    ),
    'utf8'
  )
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
      const raw = readFileSync(settingsPath, 'utf8')
      const config = parseSettingsToml(raw)
      const merged = mergePresetProviders(config.providers)
      config.providers = merged
      const serialized = stringifySettingsToml(normalizeSettingsConfig(config))
      if (serialized !== raw) {
        writeFileSync(settingsPath, serialized, 'utf8')
      }
    }
  }

  migrateLegacyImageToTextModel(settingsPath)

  // config.toml is read on hot paths (several times per chat message), so cache the
  // parsed config keyed by file stat. External writers (CLI, sync-core import) bump
  // mtime, which invalidates the cache and preserves external-edit pickup.
  let cache: { mtimeMs: number; size: number; config: SettingsConfig } | null = null

  return {
    read(): SettingsConfig {
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(settingsPath)
      } catch {
        return DEFAULT_SETTINGS_CONFIG
      }
      if (cache === null || cache.mtimeMs !== stat.mtimeMs || cache.size !== stat.size) {
        cache = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          config: parseSettingsToml(readFileSync(settingsPath, 'utf8'))
        }
      }
      // Clone so callers can never mutate the cached object.
      return structuredClone(cache.config)
    },
    write(settings: SettingsConfig): boolean {
      const serialized = stringifySettingsToml(normalizeSettingsConfig(settings))
      if (existsSync(settingsPath) && readFileSync(settingsPath, 'utf8') === serialized) {
        return false
      }
      writeFileSync(settingsPath, serialized, 'utf8')
      cache = null
      return true
    }
  }
}
