import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_MEMORY_PROVIDER,
  DEFAULT_ENABLED_TOOL_NAMES,
  DEFAULT_SIDEBAR_VISIBILITY,
  DEFAULT_TOOL_MODEL_MODE,
  normalizeMemoryProviderId,
  normalizeActiveRunEnterBehavior,
  normalizeEnabledTools,
  normalizeSidebarVisibility,
  normalizeToolModelMode,
  type BrowserBackedWebSearchSessionConfig,
  type ExaWebSearchConfig,
  type MemoryConfig,
  type ProviderConfig,
  type ProviderKind,
  type ProviderSettings,
  type SettingsConfig,
  type ToolModelConfig,
  type WebSearchConfig,
  type WebSearchProviderId,
  type WorkspaceConfig
} from '../../../shared/yachiyo/protocol.ts'
import {
  createDisabledToolModelConfig,
  ensureProviderId,
  syncToolModelWithProvider,
  resolveToolModelProvider,
  sanitizeProviderConfig
} from '../../../shared/yachiyo/providerConfig.ts'

export const DEFAULT_SETTINGS_CONFIG: SettingsConfig = {
  providers: [],
  enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
  general: {
    sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY
  },
  chat: {
    activeRunEnterBehavior: DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
  },
  workspace: {
    savedPaths: []
  },
  toolModel: {
    mode: DEFAULT_TOOL_MODEL_MODE,
    providerId: '',
    providerName: '',
    model: ''
  },
  memory: {
    enabled: false,
    provider: DEFAULT_MEMORY_PROVIDER,
    baseUrl: DEFAULT_MEMORY_BASE_URL
  },
  webSearch: {
    defaultProvider: DEFAULT_WEB_SEARCH_PROVIDER,
    browserSession: {
      sourceBrowser: undefined,
      sourceProfileName: '',
      importedAt: '',
      lastImportError: ''
    },
    exa: {
      apiKey: '',
      baseUrl: ''
    }
  }
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeProviderType(value: unknown, fallback: ProviderKind): ProviderKind {
  return value === 'openai' || value === 'anthropic' ? value : fallback
}

function normalizeWebSearchProviderId(
  value: unknown,
  fallback: WebSearchProviderId = DEFAULT_WEB_SEARCH_PROVIDER
): WebSearchProviderId {
  return value === 'google-browser' || value === 'exa' ? value : fallback
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return [...new Set(value.map((item) => normalizeString(item, '')).filter(Boolean))]
}

function normalizeWorkspaceConfig(
  value: unknown,
  fallback: WorkspaceConfig = DEFAULT_SETTINGS_CONFIG.workspace ?? {}
): WorkspaceConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    savedPaths: normalizeStringList(input['savedPaths'] ?? fallback.savedPaths)
  }
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

  return sanitizeProviderConfig({
    id: ensureProviderId(normalizeString(input['id'], fallback?.id ?? '')),
    name,
    type: normalizeProviderType(input['type'], fallback?.type ?? 'anthropic'),
    apiKey: normalizeString(input['apiKey'], fallback?.apiKey ?? ''),
    baseUrl: normalizeString(input['baseUrl'], fallback?.baseUrl ?? ''),
    modelList: {
      enabled,
      disabled
    }
  })
}

function normalizeToolModelConfig(
  value: unknown,
  fallback: ToolModelConfig = DEFAULT_SETTINGS_CONFIG.toolModel ?? {}
): ToolModelConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    mode: normalizeToolModelMode(input['mode'], fallback.mode ?? DEFAULT_TOOL_MODEL_MODE),
    providerId: normalizeString(input['providerId'], fallback.providerId ?? ''),
    providerName: normalizeString(input['providerName'], fallback.providerName ?? ''),
    model: normalizeString(input['model'], fallback.model ?? '')
  }
}

function normalizeMemoryConfig(
  value: unknown,
  fallback: MemoryConfig = DEFAULT_SETTINGS_CONFIG.memory ?? {}
): MemoryConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    enabled: input['enabled'] === true,
    provider: normalizeMemoryProviderId(
      input['provider'],
      fallback.provider ?? DEFAULT_MEMORY_PROVIDER
    ),
    baseUrl: normalizeString(input['baseUrl'], fallback.baseUrl ?? DEFAULT_MEMORY_BASE_URL)
  }
}

function normalizeBrowserSessionConfig(
  value: unknown,
  fallback: BrowserBackedWebSearchSessionConfig = DEFAULT_SETTINGS_CONFIG.webSearch
    ?.browserSession ?? {}
): BrowserBackedWebSearchSessionConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    sourceBrowser:
      input['sourceBrowser'] === 'google-chrome' ? 'google-chrome' : fallback.sourceBrowser,
    sourceProfileName: normalizeString(
      input['sourceProfileName'],
      fallback.sourceProfileName ?? ''
    ),
    importedAt: normalizeString(input['importedAt'], fallback.importedAt ?? ''),
    lastImportError: normalizeString(input['lastImportError'], fallback.lastImportError ?? '')
  }
}

function normalizeExaWebSearchConfig(
  value: unknown,
  fallback: ExaWebSearchConfig = DEFAULT_SETTINGS_CONFIG.webSearch?.exa ?? {}
): ExaWebSearchConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    apiKey: normalizeString(input['apiKey'], fallback.apiKey ?? ''),
    baseUrl: normalizeString(input['baseUrl'], fallback.baseUrl ?? '')
  }
}

function normalizeWebSearchConfig(
  value: unknown,
  fallback: WebSearchConfig = DEFAULT_SETTINGS_CONFIG.webSearch ?? {}
): WebSearchConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    defaultProvider: normalizeWebSearchProviderId(
      input['defaultProvider'],
      fallback.defaultProvider ?? DEFAULT_WEB_SEARCH_PROVIDER
    ),
    browserSession: normalizeBrowserSessionConfig(input['browserSession'], fallback.browserSession),
    exa: normalizeExaWebSearchConfig(input['exa'], fallback.exa)
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

function toResolvedProviderSettings(
  provider: ProviderConfig | null,
  model: string
): ProviderSettings | null {
  if (!provider) {
    return null
  }

  return {
    providerName: provider.name,
    provider: provider.type,
    model,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl
  }
}

export function normalizeSettingsConfig(value: unknown): SettingsConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const hasProviders = Array.isArray(input['providers'])
  const rawProviders = hasProviders ? (input['providers'] as unknown[]) : []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const providers = rawProviders.flatMap((item) => {
    const provider = normalizeProviderConfig(item)
    if (!provider || seenIds.has(provider.id ?? '') || seenNames.has(provider.name)) {
      return []
    }
    seenIds.add(provider.id ?? '')
    seenNames.add(provider.name)
    return [provider]
  })
  const toolModel = normalizeToolModelConfig(input['toolModel'])
  const resolvedToolProvider = resolveToolModelProvider({ providers }, toolModel)

  return {
    enabledTools: normalizeEnabledTools(
      input['enabledTools'],
      DEFAULT_SETTINGS_CONFIG.enabledTools
    ),
    general: {
      sidebarVisibility: normalizeSidebarVisibility(
        input['general'] && typeof input['general'] === 'object'
          ? (input['general'] as Record<string, unknown>)['sidebarVisibility']
          : undefined,
        DEFAULT_SETTINGS_CONFIG.general?.sidebarVisibility
      )
    },
    chat: {
      activeRunEnterBehavior: normalizeActiveRunEnterBehavior(
        input['chat'] && typeof input['chat'] === 'object'
          ? (input['chat'] as Record<string, unknown>)['activeRunEnterBehavior']
          : undefined,
        DEFAULT_SETTINGS_CONFIG.chat?.activeRunEnterBehavior
      )
    },
    workspace: normalizeWorkspaceConfig(input['workspace']),
    toolModel:
      toolModel.mode === 'custom'
        ? resolvedToolProvider
          ? syncToolModelWithProvider(toolModel, resolvedToolProvider)
          : createDisabledToolModelConfig()
        : toolModel,
    memory: normalizeMemoryConfig(input['memory']),
    webSearch: normalizeWebSearchConfig(input['webSearch']),
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

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'true') {
    return true
  }

  if (trimmed === 'false') {
    return false
  }

  return trimmed.startsWith('[') ? parseTomlStringArray(trimmed) : parseTomlString(trimmed)
}

export function parseSettingsToml(raw: string): SettingsConfig {
  const root: Record<string, unknown> = {}
  const providers: Array<Record<string, unknown>> = []
  let currentProvider: Record<string, unknown> | null = null
  let section:
    | 'root'
    | 'general'
    | 'chat'
    | 'workspace'
    | 'toolModel'
    | 'memory'
    | 'webSearch'
    | 'webSearch.browserSession'
    | 'webSearch.exa'
    | 'provider'
    | 'provider.modelList' = 'root'

  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue

    if (line === '[general]') {
      root['general'] = root['general'] ?? {}
      section = 'general'
      continue
    }

    if (line === '[chat]') {
      root['chat'] = root['chat'] ?? {}
      section = 'chat'
      continue
    }

    if (line === '[toolModel]') {
      root['toolModel'] = root['toolModel'] ?? {}
      section = 'toolModel'
      continue
    }

    if (line === '[workspace]') {
      root['workspace'] = root['workspace'] ?? {}
      section = 'workspace'
      continue
    }

    if (line === '[memory]') {
      root['memory'] = root['memory'] ?? {}
      section = 'memory'
      continue
    }

    if (line === '[webSearch]') {
      root['webSearch'] = root['webSearch'] ?? {}
      section = 'webSearch'
      continue
    }

    if (line === '[webSearch.browserSession]') {
      const webSearch =
        root['webSearch'] && typeof root['webSearch'] === 'object'
          ? (root['webSearch'] as Record<string, unknown>)
          : null
      if (!webSearch) {
        throw new Error('Encountered [webSearch.browserSession] before [webSearch].')
      }
      webSearch['browserSession'] = webSearch['browserSession'] ?? {}
      section = 'webSearch.browserSession'
      continue
    }

    if (line === '[webSearch.exa]') {
      const webSearch =
        root['webSearch'] && typeof root['webSearch'] === 'object'
          ? (root['webSearch'] as Record<string, unknown>)
          : null
      if (!webSearch) {
        throw new Error('Encountered [webSearch.exa] before [webSearch].')
      }
      webSearch['exa'] = webSearch['exa'] ?? {}
      section = 'webSearch.exa'
      continue
    }

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
    const value = parseTomlValue(rawValue.trim())

    if (section === 'root') {
      root[key] = value
      continue
    }

    if (section === 'general') {
      const general =
        root['general'] && typeof root['general'] === 'object'
          ? (root['general'] as Record<string, unknown>)
          : null

      if (!general) {
        throw new Error(`General settings are not initialized for ${key}.`)
      }

      general[key] = value
      continue
    }

    if (section === 'chat') {
      const chat =
        root['chat'] && typeof root['chat'] === 'object'
          ? (root['chat'] as Record<string, unknown>)
          : null

      if (!chat) {
        throw new Error(`Chat settings are not initialized for ${key}.`)
      }

      chat[key] = value
      continue
    }

    if (section === 'toolModel') {
      const toolModel =
        root['toolModel'] && typeof root['toolModel'] === 'object'
          ? (root['toolModel'] as Record<string, unknown>)
          : null

      if (!toolModel) {
        throw new Error(`Tool model settings are not initialized for ${key}.`)
      }

      toolModel[key] = value
      continue
    }

    if (section === 'workspace') {
      const workspace =
        root['workspace'] && typeof root['workspace'] === 'object'
          ? (root['workspace'] as Record<string, unknown>)
          : null

      if (!workspace) {
        throw new Error(`Workspace settings are not initialized for ${key}.`)
      }

      workspace[key] = value
      continue
    }

    if (section === 'memory') {
      const memory =
        root['memory'] && typeof root['memory'] === 'object'
          ? (root['memory'] as Record<string, unknown>)
          : null

      if (!memory) {
        throw new Error(`Memory settings are not initialized for ${key}.`)
      }

      memory[key] = value
      continue
    }

    if (section === 'webSearch') {
      const webSearch =
        root['webSearch'] && typeof root['webSearch'] === 'object'
          ? (root['webSearch'] as Record<string, unknown>)
          : null
      if (!webSearch) {
        throw new Error(`Web search settings are not initialized for ${key}.`)
      }
      webSearch[key] = value
      continue
    }

    if (section === 'webSearch.browserSession' || section === 'webSearch.exa') {
      const webSearch =
        root['webSearch'] && typeof root['webSearch'] === 'object'
          ? (root['webSearch'] as Record<string, unknown>)
          : null
      const nested =
        webSearch &&
        typeof webSearch[section === 'webSearch.browserSession' ? 'browserSession' : 'exa'] ===
          'object'
          ? (webSearch[section === 'webSearch.browserSession' ? 'browserSession' : 'exa'] as Record<
              string,
              unknown
            >)
          : null

      if (!nested) {
        throw new Error(`Web search nested settings are not initialized for ${key}.`)
      }

      nested[key] = value
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
  const normalized = normalizeSettingsConfig(config)
  const toolModel = normalizeToolModelConfig(normalized.toolModel)
  const memory = normalizeMemoryConfig(normalized.memory)
  const lines: string[] = [
    `enabledTools = ${stringifyTomlStringArray(
      normalizeEnabledTools(normalized.enabledTools, DEFAULT_SETTINGS_CONFIG.enabledTools)
    )}`,
    '',
    '[general]',
    `sidebarVisibility = ${stringifyTomlString(
      normalizeSidebarVisibility(
        normalized.general?.sidebarVisibility,
        DEFAULT_SETTINGS_CONFIG.general?.sidebarVisibility
      )
    )}`,
    '',
    '[chat]',
    `activeRunEnterBehavior = ${stringifyTomlString(
      normalizeActiveRunEnterBehavior(
        normalized.chat?.activeRunEnterBehavior,
        DEFAULT_SETTINGS_CONFIG.chat?.activeRunEnterBehavior
      )
    )}`,
    '',
    '[workspace]',
    `savedPaths = ${stringifyTomlStringArray(normalized.workspace?.savedPaths ?? [])}`,
    '',
    '[toolModel]',
    `mode = ${stringifyTomlString(toolModel.mode ?? DEFAULT_TOOL_MODEL_MODE)}`,
    `providerId = ${stringifyTomlString(toolModel.providerId ?? '')}`,
    `providerName = ${stringifyTomlString(toolModel.providerName ?? '')}`,
    `model = ${stringifyTomlString(toolModel.model ?? '')}`,
    '',
    '[memory]',
    `enabled = ${memory.enabled ? 'true' : 'false'}`,
    `provider = ${stringifyTomlString(memory.provider ?? DEFAULT_MEMORY_PROVIDER)}`,
    `baseUrl = ${stringifyTomlString(memory.baseUrl ?? DEFAULT_MEMORY_BASE_URL)}`,
    '',
    '[webSearch]',
    `defaultProvider = ${stringifyTomlString(
      normalizeWebSearchProviderId(normalized.webSearch?.defaultProvider)
    )}`,
    '',
    '[webSearch.browserSession]',
    `sourceBrowser = ${stringifyTomlString(normalized.webSearch?.browserSession?.sourceBrowser ?? '')}`,
    `sourceProfileName = ${stringifyTomlString(
      normalized.webSearch?.browserSession?.sourceProfileName ?? ''
    )}`,
    `importedAt = ${stringifyTomlString(normalized.webSearch?.browserSession?.importedAt ?? '')}`,
    `lastImportError = ${stringifyTomlString(
      normalized.webSearch?.browserSession?.lastImportError ?? ''
    )}`,
    '',
    '[webSearch.exa]',
    `apiKey = ${stringifyTomlString(normalized.webSearch?.exa?.apiKey ?? '')}`,
    `baseUrl = ${stringifyTomlString(normalized.webSearch?.exa?.baseUrl ?? '')}`
  ]

  for (const provider of normalized.providers) {
    lines.push(
      '',
      '[[providers]]',
      `id = ${stringifyTomlString(ensureProviderId(provider.id))}`,
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

  return (
    toResolvedProviderSettings(provider, model) ?? {
      providerName: '',
      provider: 'anthropic',
      model: '',
      apiKey: '',
      baseUrl: ''
    }
  )
}

export function toToolModelSettings(config: SettingsConfig): ProviderSettings | null {
  const normalizedConfig = normalizeSettingsConfig(config)
  const toolModel = normalizeToolModelConfig(normalizedConfig.toolModel)

  if (toolModel.mode === 'disabled') {
    return null
  }

  const provider = resolveToolModelProvider(normalizedConfig, toolModel)
  return toResolvedProviderSettings(provider, toolModel.model ?? '')
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
