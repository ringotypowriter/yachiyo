import { createHash } from 'node:crypto'

import type {
  ProviderConfig,
  SettingsConfig,
  SyncSettingsFieldDiff
} from '@yachiyo/shared/protocol'
import { stripProviderCredentials } from './providerCredentialConfig.ts'

/**
 * Field-level diff/merge for settings conflicts. Settings are compared at leaf
 * granularity (e.g. `general.themeId`, `chat.model`). Providers are compared by id
 * when the snapshots agree on membership, names, and order. Changes to that list
 * structure and other arrays remain atomic. Operates on normalized config objects.
 */

const MAX_DISPLAY = 160
const LOCAL_ONLY_SETTING_PATHS = new Set(['sync.syncDir'])
// Remote access and executable plugin enablement belong to the local device.
const LOCAL_ONLY_SETTING_PREFIXES = ['remote.', 'plugins.']

function isLocalOnlySettingPath(path: string): boolean {
  return (
    LOCAL_ONLY_SETTING_PATHS.has(path) ||
    LOCAL_ONLY_SETTING_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      out.set(prefix, value)
      return
    }
    for (const key of keys) {
      flatten(value[key], prefix ? `${prefix}.${key}` : key, out)
    }
    return
  }
  // Arrays and scalars are atomic leaves.
  out.set(prefix, value)
}

function providerFieldPath(provider: ProviderConfig): string {
  // Conflict paths are shown in settings; keep the provider name readable there.
  return `providers[${provider.name}]`
}

function haveMatchingProviderLists(configs: SettingsConfig[]): boolean {
  const providers = configs[0].providers
  return (
    Array.isArray(providers) &&
    providers.every((provider) => Boolean(provider.id)) &&
    configs
      .slice(1)
      .every(
        (config) =>
          Array.isArray(config.providers) &&
          config.providers.length === providers.length &&
          config.providers.every(
            (provider, index) =>
              provider.id === providers[index].id && provider.name === providers[index].name
          )
      )
  )
}

function flattenConfig(config: unknown, separateProviders = false): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const publicConfig =
    isPlainObject(config) && Array.isArray(config['providers'])
      ? stripProviderCredentials(config as unknown as SettingsConfig)
      : config
  if (isPlainObject(publicConfig) && Array.isArray(publicConfig['providers'])) {
    for (const provider of publicConfig['providers']) {
      delete provider.codexSessionPath
    }
  }
  if (isPlainObject(publicConfig)) {
    for (const key of Object.keys(publicConfig)) {
      if (key === 'providers' && separateProviders) {
        for (const provider of publicConfig[key] as ProviderConfig[]) {
          out.set(providerFieldPath(provider), provider)
        }
      } else {
        flatten(publicConfig[key], key, out)
      }
    }
  }
  return out
}

/** Order-stable for objects (sorted keys) but order-sensitive for arrays. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function display(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const json = stableStringify(value)
  return json.length > MAX_DISPLAY ? `${json.slice(0, MAX_DISPLAY - 1)}…` : json
}

export interface SettingsFieldDifference extends SyncSettingsFieldDiff {
  localFingerprint: string
  remoteFingerprint: string
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/**
 * Fields whose values differ, with full-value fingerprints for resolution memory.
 * Pass the third snapshot during a three-way comparison so every pair uses the
 * same provider granularity, including concurrent list changes and provider edits.
 */
export function diffSettingsForResolution(
  local: SettingsConfig,
  remote: SettingsConfig,
  providerContext?: SettingsConfig
): SettingsFieldDifference[] {
  const separateProviders = haveMatchingProviderLists(
    providerContext ? [local, remote, providerContext] : [local, remote]
  )
  const localFields = flattenConfig(local, separateProviders)
  const remoteFields = flattenConfig(remote, separateProviders)
  const paths = new Set([...localFields.keys(), ...remoteFields.keys()])
  const diffs: SettingsFieldDifference[] = []
  for (const path of [...paths].sort()) {
    if (isLocalOnlySettingPath(path)) continue
    const localValue = localFields.get(path)
    const remoteValue = remoteFields.get(path)
    if (stableStringify(localValue) === stableStringify(remoteValue)) continue
    diffs.push({
      path,
      localValue: display(localValue),
      remoteValue: display(remoteValue),
      localFingerprint: fingerprint(localValue),
      remoteFingerprint: fingerprint(remoteValue)
    })
  }
  return diffs
}

/** Leaf fields whose values differ between the two configs. */
export function diffSettings(
  local: SettingsConfig,
  remote: SettingsConfig
): SyncSettingsFieldDiff[] {
  return diffSettingsForResolution(local, remote).map(
    ({ path, localValue, remoteValue }): SyncSettingsFieldDiff => ({
      path,
      localValue,
      remoteValue
    })
  )
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (!isPlainObject(cursor[key])) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

function deleteByPath(target: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (!isPlainObject(cursor[key])) return
    cursor = cursor[key] as Record<string, unknown>
  }
  delete cursor[parts[parts.length - 1]]
}

/**
 * Merge starting from `local`, overriding only the fields the user assigned to
 * `'remote'`. Unlisted fields (and `'local'` choices) keep the local value, so
 * non-conflicting settings are preserved untouched.
 */
export function mergeSettings(
  local: SettingsConfig,
  remote: SettingsConfig,
  selections: Record<string, 'local' | 'remote'>
): SettingsConfig {
  const remoteFields = flattenConfig(remote)
  const merged = structuredClone(local)
  let providersChanged = false
  for (const [path, choice] of Object.entries(selections)) {
    if (isLocalOnlySettingPath(path)) continue
    if (choice !== 'remote') continue
    if (path.startsWith('providers[')) {
      const index = merged.providers.findIndex((provider) => providerFieldPath(provider) === path)
      const remoteProvider = (remoteFields.get('providers') as ProviderConfig[]).find(
        (provider) => providerFieldPath(provider) === path
      )
      if (index < 0 || !remoteProvider || merged.providers[index].id !== remoteProvider.id) {
        throw new Error(`Provider no longer exists for settings field "${path}"`)
      }
      merged.providers[index] = structuredClone(remoteProvider)
      providersChanged = true
      continue
    }
    if (remoteFields.has(path)) {
      setByPath(
        merged as unknown as Record<string, unknown>,
        path,
        structuredClone(remoteFields.get(path))
      )
    } else {
      deleteByPath(merged as unknown as Record<string, unknown>, path)
    }
    if (path === 'providers') providersChanged = true
  }
  return providersChanged ? preserveLocalCodexSessionPaths(local, merged) : merged
}

/** OAuth session files are device-local, even when the provider configuration is synced. */
export function preserveLocalCodexSessionPaths(
  local: SettingsConfig,
  remote: SettingsConfig
): SettingsConfig {
  return {
    ...remote,
    providers: remote.providers.map((provider) => {
      const stored =
        local.providers.find((entry) => entry.id && entry.id === provider.id) ??
        local.providers.find((entry) => entry.name === provider.name)
      const next = { ...provider }
      delete next.codexSessionPath
      if (stored?.codexSessionPath) next.codexSessionPath = stored.codexSessionPath
      return next
    })
  }
}
