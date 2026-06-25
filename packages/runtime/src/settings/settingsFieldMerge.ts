import type { SettingsConfig, SyncSettingsFieldDiff } from '@yachiyo/shared/protocol'

/**
 * Field-level diff/merge for settings conflicts. Settings are compared at leaf
 * granularity (e.g. `general.themeId`, `chat.model`); arrays (providers, prompts,
 * channels…) are treated as atomic units because element-wise array merging needs
 * stable identity we don't have. Operates on already-normalized config objects.
 */

const MAX_DISPLAY = 160
const LOCAL_ONLY_SETTING_PATHS = new Set(['sync.syncDir'])

function isLocalOnlySettingPath(path: string): boolean {
  return LOCAL_ONLY_SETTING_PATHS.has(path)
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

function flattenConfig(config: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (isPlainObject(config)) {
    for (const key of Object.keys(config)) {
      flatten(config[key], key, out)
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

/** Leaf fields whose values differ between the two configs. */
export function diffSettings(
  local: SettingsConfig,
  remote: SettingsConfig
): SyncSettingsFieldDiff[] {
  const localFields = flattenConfig(local)
  const remoteFields = flattenConfig(remote)
  const paths = new Set([...localFields.keys(), ...remoteFields.keys()])
  const diffs: SyncSettingsFieldDiff[] = []
  for (const path of [...paths].sort()) {
    if (isLocalOnlySettingPath(path)) continue
    const localValue = localFields.get(path)
    const remoteValue = remoteFields.get(path)
    if (stableStringify(localValue) === stableStringify(remoteValue)) continue
    diffs.push({ path, localValue: display(localValue), remoteValue: display(remoteValue) })
  }
  return diffs
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
  const merged = structuredClone(local) as unknown as Record<string, unknown>
  for (const [path, choice] of Object.entries(selections)) {
    if (isLocalOnlySettingPath(path)) continue
    if (choice !== 'remote') continue
    if (remoteFields.has(path)) {
      setByPath(merged, path, structuredClone(remoteFields.get(path)))
    } else {
      deleteByPath(merged, path)
    }
  }
  return merged as unknown as SettingsConfig
}
