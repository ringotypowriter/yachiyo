import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  ProviderConfig,
  ProviderKind,
  ProviderSettings,
  SettingsConfig
} from '../../../shared/yachiyo/protocol'

export const DEFAULT_SETTINGS_CONFIG: SettingsConfig = {
  providers: []
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeProviderType(value: unknown, fallback: ProviderKind): ProviderKind {
  return value === 'openai' || value === 'anthropic' ? value : fallback
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return [...new Set(value.map((item) => normalizeString(item, '')).filter(Boolean))]
}

function normalizeProviderConfig(value: unknown, fallback?: ProviderConfig): ProviderConfig | null {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const name = normalizeString(input['name'], fallback?.name ?? '')

  if (!name) {
    return null
  }

  const enabled = normalizeStringList(
    input['modelList'] && typeof input['modelList'] === 'object'
      ? (input['modelList'] as Record<string, unknown>)['enabled']
      : undefined
  )
  const disabled = normalizeStringList(
    input['modelList'] && typeof input['modelList'] === 'object'
      ? (input['modelList'] as Record<string, unknown>)['disabled']
      : undefined
  ).filter((model) => !enabled.includes(model))

  return {
    name,
    type: normalizeProviderType(input['type'], fallback?.type ?? 'anthropic'),
    apiKey: normalizeString(input['apiKey'], fallback?.apiKey ?? ''),
    baseUrl: normalizeString(input['baseUrl'], fallback?.baseUrl ?? ''),
    modelList: {
      enabled,
      disabled
    }
  }
}

function resolvePrimaryProvider(config: SettingsConfig): ProviderConfig | null {
  return (
    config.providers.find((provider) => provider.modelList.enabled.length > 0) ??
    config.providers[0] ??
    null
  )
}

function resolvePrimaryModel(provider: ProviderConfig | null): string {
  if (!provider) {
    return ''
  }

  return provider.modelList.enabled[0] ?? ''
}

export function normalizeSettingsConfig(value: unknown): SettingsConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const hasProviders = Array.isArray(input['providers'])
  const rawProviders = hasProviders ? (input['providers'] as unknown[]) : []
  const seen = new Set<string>()
  const providers = rawProviders.flatMap((item) => {
    const provider = normalizeProviderConfig(item)
    if (!provider || seen.has(provider.name)) {
      return []
    }
    seen.add(provider.name)
    return [provider]
  })

  return {
    providers: hasProviders ? providers : DEFAULT_SETTINGS_CONFIG.providers
  }
}

function stripTomlComment(line: string): string {
  let inString = false
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]

    if (char === '"' && !escaped) {
      inString = !inString
    } else if (char === '#' && !inString) {
      return line.slice(0, index)
    }

    escaped = char === '\\' && !escaped
  }

  return line
}

function parseTomlString(value: string): string {
  return JSON.parse(value)
}

function parseTomlStringArray(value: string): string[] {
  const parsed = JSON.parse(value)
  return Array.isArray(parsed)
    ? parsed.map((item) => normalizeString(item, '')).filter(Boolean)
    : []
}

export function parseSettingsToml(raw: string): SettingsConfig {
  const root: Record<string, unknown> = {}
  const providers: Array<Record<string, unknown>> = []
  let currentProvider: Record<string, unknown> | null = null
  let section: 'root' | 'provider' | 'provider.modelList' = 'root'

  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue

    if (line === '[[providers]]') {
      currentProvider = {}
      providers.push(currentProvider)
      section = 'provider'
      continue
    }

    if (line === '[providers.modelList]') {
      if (!currentProvider) {
        throw new Error('Encountered [providers.modelList] before [[providers]].')
      }
      currentProvider['modelList'] = currentProvider['modelList'] ?? {}
      section = 'provider.modelList'
      continue
    }

    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/u.exec(line)
    if (!match) {
      throw new Error(`Unsupported TOML line: ${rawLine}`)
    }

    const [, key, rawValue] = match
    const value = rawValue.trim().startsWith('[')
      ? parseTomlStringArray(rawValue.trim())
      : parseTomlString(rawValue.trim())

    if (section === 'root') {
      root[key] = value
      continue
    }

    if (section === 'provider') {
      if (!currentProvider) {
        throw new Error(`Provider entry is not initialized for ${key}.`)
      }
      currentProvider[key] = value
      continue
    }

    const modelList =
      currentProvider && typeof currentProvider['modelList'] === 'object'
        ? (currentProvider['modelList'] as Record<string, unknown>)
        : null

    if (!modelList) {
      throw new Error(`Provider model list is not initialized for ${key}.`)
    }

    modelList[key] = value
  }

  return normalizeSettingsConfig({
    ...root,
    providers
  })
}

function stringifyTomlString(value: string): string {
  return JSON.stringify(value)
}

function stringifyTomlStringArray(values: string[]): string {
  return JSON.stringify(values)
}

export function stringifySettingsToml(config: SettingsConfig): string {
  const lines: string[] = []

  for (const provider of config.providers) {
    lines.push(
      '',
      '[[providers]]',
      `name = ${stringifyTomlString(provider.name)}`,
      `type = ${stringifyTomlString(provider.type)}`,
      `apiKey = ${stringifyTomlString(provider.apiKey)}`,
      `baseUrl = ${stringifyTomlString(provider.baseUrl)}`,
      '',
      '[providers.modelList]',
      `enabled = ${stringifyTomlStringArray(provider.modelList.enabled)}`,
      `disabled = ${stringifyTomlStringArray(provider.modelList.disabled)}`
    )
  }

  return `${lines.join('\n').trim()}\n`
}

export function toProviderSettings(config: SettingsConfig): ProviderSettings {
  const provider = resolvePrimaryProvider(config)
  const model = resolvePrimaryModel(provider)

  return {
    providerName: provider?.name ?? '',
    provider: provider?.type ?? 'anthropic',
    model,
    apiKey: provider?.apiKey ?? '',
    baseUrl: provider?.baseUrl ?? ''
  }
}

export interface SettingsStore {
  read: () => SettingsConfig
  write: (settings: SettingsConfig) => void
}

export function createSettingsStore(settingsPath: string): SettingsStore {
  mkdirSync(dirname(settingsPath), { recursive: true })

  return {
    read() {
      if (!existsSync(settingsPath)) {
        return DEFAULT_SETTINGS_CONFIG
      }

      return parseSettingsToml(readFileSync(settingsPath, 'utf8'))
    },
    write(settings) {
      writeFileSync(settingsPath, stringifySettingsToml(normalizeSettingsConfig(settings)), 'utf8')
    }
  }
}
