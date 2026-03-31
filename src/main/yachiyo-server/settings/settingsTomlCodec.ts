import TOML from 'smol-toml'

import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { readConfigFromTomlSlices, writeTomlDocFromSlices } from '../config/tomlSlices.ts'
import { normalizeSettingsConfig } from './settingsConfig.ts'
import { settingsTomlSlices } from './settingsTomlSlices.ts'

/**
 * Quote a TOML bare key only when it contains characters that are not
 * allowed in a bare key (A-Za-z0-9, `-`, `_`). Keys like `foo.bar`
 * must be quoted to avoid being interpreted as dotted paths.
 */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key)
}

/**
 * Fix legacy config files that serialized the `env` field as raw JSON
 * (`env = {"KEY":"value"}`) instead of a TOML inline table.
 * smol-toml rejects JSON objects, so we rewrite them to TOML syntax first.
 *
 * The regex allows an optional trailing TOML comment (`# ...`) after the
 * JSON object, since the old hand-written parser stripped comments before
 * value parsing.
 */
function fixLegacyJsonEnv(raw: string): string {
  return raw.replace(
    /^(\s*env\s*=\s*)(\{.*\})\s*(?:#.*)?$/gm,
    (_match, prefix: string, rest: string) => {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(rest) as Record<string, unknown>
      } catch {
        return `${prefix}${rest}`
      }
      const pairs = Object.entries(obj)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => `${tomlKey(key)} = ${JSON.stringify(value)}`)
        .join(', ')
      return `${prefix}{ ${pairs} }`
    }
  )
}

export function parseSettingsToml(raw: string): SettingsConfig {
  const doc = TOML.parse(fixLegacyJsonEnv(raw))
  const partialConfig = readConfigFromTomlSlices<SettingsConfig>(doc, settingsTomlSlices)
  return normalizeSettingsConfig(partialConfig)
}

export function stringifySettingsToml(config: SettingsConfig): string {
  const normalized = normalizeSettingsConfig(config)
  const doc = writeTomlDocFromSlices(normalized, settingsTomlSlices)
  return TOML.stringify(doc)
}
