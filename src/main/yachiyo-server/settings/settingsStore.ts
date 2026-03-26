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
  normalizeUserEnabledTools,
  normalizeSidebarVisibility,
  normalizeToolModelMode,
  normalizeUserPrompts,
  type BrowserBackedWebSearchSessionConfig,
  type ExaWebSearchConfig,
  type GeneralConfig,
  type MemoryConfig,
  type ProviderConfig,
  type ProviderKind,
  type ProviderSettings,
  type SkillsConfig,
  type SettingsConfig,
  type SubagentProfile,
  type ThreadModelOverride,
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
    sidebarVisibility: DEFAULT_SIDEBAR_VISIBILITY,
    notifyRunCompleted: true,
    notifyCodingTaskStarted: true,
    notifyCodingTaskFinished: true
  },
  chat: {
    activeRunEnterBehavior: DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
  },
  workspace: {
    savedPaths: []
  },
  skills: {
    enabled: []
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
  prompts: [],
  subagentProfiles: [
    {
      id: 'claude-code-default',
      name: 'Claude Code',
      enabled: true,
      description: 'Default Claude Code agent. Best for multi-file refactoring and deep reasoning.',
      command: 'npx',
      args: ['-y', '@zed-industries/claude-agent-acp'],
      env: { ACP_PERMISSION_MODE: 'acceptEdits' }
    }
  ],
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
  return value === 'openai' ||
    value === 'openai-responses' ||
    value === 'anthropic' ||
    value === 'gemini' ||
    value === 'vertex' ||
    value === 'vercel-gateway'
    ? (value as ProviderKind)
    : fallback
}

function isLegacyGatewayVertexProvider(input: Record<string, unknown>): boolean {
  if (input['type'] !== 'vertex') {
    return false
  }

  const project = normalizeString(input['project'], '')
  if (project) {
    return false
  }

  const apiKey = normalizeString(input['apiKey'], '')
  const baseUrl = normalizeString(input['baseUrl'], '')
  return !!apiKey || !!baseUrl
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

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

function normalizeOptionalBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeGeneralConfig(value: unknown): GeneralConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const result: GeneralConfig = {
    sidebarVisibility: normalizeSidebarVisibility(
      input['sidebarVisibility'],
      DEFAULT_SETTINGS_CONFIG.general?.sidebarVisibility
    ),
    notifyRunCompleted: normalizeOptionalBool(input['notifyRunCompleted'], true),
    notifyCodingTaskStarted: normalizeOptionalBool(input['notifyCodingTaskStarted'], true),
    notifyCodingTaskFinished: normalizeOptionalBool(input['notifyCodingTaskFinished'], true)
  }
  const uiFontSize = normalizePositiveInt(input['uiFontSize'])
  const chatFontSize = normalizePositiveInt(input['chatFontSize'])
  if (uiFontSize !== undefined) result.uiFontSize = uiFontSize
  if (chatFontSize !== undefined) result.chatFontSize = chatFontSize
  return result
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

function normalizeSkillsConfig(
  value: unknown,
  fallback: SkillsConfig = DEFAULT_SETTINGS_CONFIG.skills ?? {}
): SkillsConfig {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    enabled: normalizeStringList(input['enabled'] ?? fallback.enabled)
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
    type: isLegacyGatewayVertexProvider(input)
      ? 'vercel-gateway'
      : normalizeProviderType(input['type'], fallback?.type ?? 'anthropic'),
    apiKey: normalizeString(input['apiKey'], fallback?.apiKey ?? ''),
    baseUrl: normalizeString(input['baseUrl'], fallback?.baseUrl ?? ''),
    project: normalizeString(input['project'], fallback?.project ?? ''),
    location: normalizeString(input['location'], fallback?.location ?? ''),
    serviceAccountEmail: normalizeString(
      input['serviceAccountEmail'],
      fallback?.serviceAccountEmail ?? ''
    ),
    serviceAccountPrivateKey: normalizeString(
      input['serviceAccountPrivateKey'],
      fallback?.serviceAccountPrivateKey ?? ''
    ),
    modelList: {
      enabled,
      disabled
    }
  })
}

function normalizeDefaultModel(value: unknown): ThreadModelOverride | undefined {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const providerName = normalizeString(input['providerName'], '')
  const model = normalizeString(input['model'], '')
  if (!providerName || !model) return undefined
  return { providerName, model }
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
    baseUrl: provider.baseUrl,
    project: provider.project,
    location: provider.location,
    serviceAccountEmail: provider.serviceAccountEmail,
    serviceAccountPrivateKey: provider.serviceAccountPrivateKey
  }
}

function normalizeSubagentProfile(value: unknown): SubagentProfile | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const id = normalizeString(input['id'], '')
  const name = normalizeString(input['name'], '')
  if (!id || !name) return null

  const rawArgs = input['args']
  const args = Array.isArray(rawArgs)
    ? rawArgs.map((a) => normalizeString(a, '')).filter(Boolean)
    : []

  const rawEnv = input['env']
  const env: Record<string, string> = {}
  if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v
    }
  }

  return {
    id,
    name,
    enabled: input['enabled'] === true,
    description: normalizeString(input['description'], ''),
    command: normalizeString(input['command'], ''),
    args,
    env
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

  const hasSubagentProfiles = Array.isArray(input['subagentProfiles'])
  const subagentProfiles = hasSubagentProfiles
    ? (input['subagentProfiles'] as unknown[]).flatMap((item) => {
        const profile = normalizeSubagentProfile(item)
        return profile ? [profile] : []
      })
    : DEFAULT_SETTINGS_CONFIG.subagentProfiles

  const defaultModel = normalizeDefaultModel(input['defaultModel'])

  return {
    ...(defaultModel ? { defaultModel } : {}),
    enabledTools: normalizeUserEnabledTools(
      input['enabledTools'],
      DEFAULT_SETTINGS_CONFIG.enabledTools
    ),
    general: normalizeGeneralConfig(input['general']),
    chat: {
      activeRunEnterBehavior: normalizeActiveRunEnterBehavior(
        input['chat'] && typeof input['chat'] === 'object'
          ? (input['chat'] as Record<string, unknown>)['activeRunEnterBehavior']
          : undefined,
        DEFAULT_SETTINGS_CONFIG.chat?.activeRunEnterBehavior
      )
    },
    workspace: normalizeWorkspaceConfig(input['workspace']),
    skills: normalizeSkillsConfig(input['skills']),
    toolModel:
      toolModel.mode === 'custom'
        ? resolvedToolProvider
          ? syncToolModelWithProvider(toolModel, resolvedToolProvider)
          : createDisabledToolModelConfig()
        : toolModel,
    memory: normalizeMemoryConfig(input['memory']),
    webSearch: normalizeWebSearchConfig(input['webSearch']),
    providers: hasProviders ? providers : DEFAULT_SETTINGS_CONFIG.providers,
    prompts: normalizeUserPrompts(input['prompts']),
    subagentProfiles
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
  const prompts: Array<Record<string, unknown>> = []
  const subagentProfiles: Array<Record<string, unknown>> = []
  let currentProvider: Record<string, unknown> | null = null
  let currentPrompt: Record<string, unknown> | null = null
  let currentSubagentProfile: Record<string, unknown> | null = null
  let section:
    | 'root'
    | 'general'
    | 'chat'
    | 'workspace'
    | 'skills'
    | 'toolModel'
    | 'defaultModel'
    | 'memory'
    | 'webSearch'
    | 'webSearch.browserSession'
    | 'webSearch.exa'
    | 'provider'
    | 'provider.modelList'
    | 'prompt'
    | 'subagentProfile' = 'root'

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

    if (line === '[defaultModel]') {
      root['defaultModel'] = root['defaultModel'] ?? {}
      section = 'defaultModel'
      continue
    }

    if (line === '[skills]') {
      root['skills'] = root['skills'] ?? {}
      section = 'skills'
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

    if (line === '[[prompts]]') {
      currentPrompt = {}
      prompts.push(currentPrompt)
      section = 'prompt'
      continue
    }

    if (line === '[[subagentProfiles]]') {
      currentSubagentProfile = {}
      subagentProfiles.push(currentSubagentProfile)
      section = 'subagentProfile'
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

    if (section === 'defaultModel') {
      const defaultModel =
        root['defaultModel'] && typeof root['defaultModel'] === 'object'
          ? (root['defaultModel'] as Record<string, unknown>)
          : null

      if (!defaultModel) {
        throw new Error(`Default model settings are not initialized for ${key}.`)
      }

      defaultModel[key] = value
      continue
    }

    if (section === 'skills') {
      const skills =
        root['skills'] && typeof root['skills'] === 'object'
          ? (root['skills'] as Record<string, unknown>)
          : null

      if (!skills) {
        throw new Error(`Skill settings are not initialized for ${key}.`)
      }

      skills[key] = value
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

    if (section === 'prompt') {
      if (!currentPrompt) {
        throw new Error(`Prompt entry is not initialized for ${key}.`)
      }
      currentPrompt[key] = value
      continue
    }

    if (section === 'subagentProfile') {
      if (!currentSubagentProfile) {
        throw new Error(`SubagentProfile entry is not initialized for ${key}.`)
      }
      currentSubagentProfile[key] = value
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
    providers,
    prompts,
    subagentProfiles
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
      normalizeUserEnabledTools(normalized.enabledTools, DEFAULT_SETTINGS_CONFIG.enabledTools)
    )}`,
    '',
    '[general]',
    `sidebarVisibility = ${stringifyTomlString(
      normalizeSidebarVisibility(
        normalized.general?.sidebarVisibility,
        DEFAULT_SETTINGS_CONFIG.general?.sidebarVisibility
      )
    )}`,
    `notifyRunCompleted = ${normalized.general?.notifyRunCompleted !== false ? 'true' : 'false'}`,
    `notifyCodingTaskStarted = ${normalized.general?.notifyCodingTaskStarted !== false ? 'true' : 'false'}`,
    `notifyCodingTaskFinished = ${normalized.general?.notifyCodingTaskFinished !== false ? 'true' : 'false'}`,
    ...(normalized.general?.uiFontSize != null
      ? [`uiFontSize = ${normalized.general.uiFontSize}`]
      : []),
    ...(normalized.general?.chatFontSize != null
      ? [`chatFontSize = ${normalized.general.chatFontSize}`]
      : []),
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
    '[skills]',
    `enabled = ${stringifyTomlStringArray(normalized.skills?.enabled ?? [])}`,
    '',
    '[toolModel]',
    `mode = ${stringifyTomlString(toolModel.mode ?? DEFAULT_TOOL_MODEL_MODE)}`,
    `providerId = ${stringifyTomlString(toolModel.providerId ?? '')}`,
    `providerName = ${stringifyTomlString(toolModel.providerName ?? '')}`,
    `model = ${stringifyTomlString(toolModel.model ?? '')}`,
    '',
    '[defaultModel]',
    `providerName = ${stringifyTomlString(normalized.defaultModel?.providerName ?? '')}`,
    `model = ${stringifyTomlString(normalized.defaultModel?.model ?? '')}`,
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
      `project = ${stringifyTomlString(provider.project ?? '')}`,
      `location = ${stringifyTomlString(provider.location ?? '')}`,
      `serviceAccountEmail = ${stringifyTomlString(provider.serviceAccountEmail ?? '')}`,
      `serviceAccountPrivateKey = ${stringifyTomlString(provider.serviceAccountPrivateKey ?? '')}`,
      '',
      '[providers.modelList]',
      `enabled = ${stringifyTomlStringArray(provider.modelList.enabled)}`,
      `disabled = ${stringifyTomlStringArray(provider.modelList.disabled)}`
    )
  }

  for (const prompt of normalized.prompts ?? []) {
    lines.push(
      '',
      '[[prompts]]',
      `keycode = ${stringifyTomlString(prompt.keycode)}`,
      `text = ${stringifyTomlString(prompt.text)}`
    )
  }

  for (const profile of normalized.subagentProfiles ?? []) {
    lines.push(
      '',
      '[[subagentProfiles]]',
      `id = ${stringifyTomlString(profile.id)}`,
      `name = ${stringifyTomlString(profile.name)}`,
      `enabled = ${profile.enabled ? 'true' : 'false'}`,
      `description = ${stringifyTomlString(profile.description)}`,
      `command = ${stringifyTomlString(profile.command)}`,
      `args = ${stringifyTomlStringArray(profile.args)}`,
      `env = ${JSON.stringify(profile.env)}`
    )
  }

  return `${lines.join('\n').trim()}\n`
}

export function toEffectiveProviderSettings(
  config: SettingsConfig,
  modelOverride?: ThreadModelOverride
): ProviderSettings {
  if (!modelOverride) {
    return toProviderSettings(config)
  }

  const provider = config.providers.find((p) => p.name === modelOverride.providerName)
  if (!provider) {
    return toProviderSettings(config)
  }

  return toResolvedProviderSettings(provider, modelOverride.model) ?? toProviderSettings(config)
}

export function toProviderSettings(config: SettingsConfig): ProviderSettings {
  const empty: ProviderSettings = {
    providerName: '',
    provider: 'anthropic',
    model: '',
    apiKey: '',
    baseUrl: '',
    project: '',
    location: '',
    serviceAccountEmail: '',
    serviceAccountPrivateKey: ''
  }

  const { defaultModel } = config
  if (defaultModel?.providerName && defaultModel?.model) {
    const provider = config.providers.find((p) => p.name === defaultModel.providerName)
    if (provider) {
      return toResolvedProviderSettings(provider, defaultModel.model) ?? empty
    }
  }

  const provider = resolvePrimaryProvider(config)
  const model = resolvePrimaryModel(provider)
  return toResolvedProviderSettings(provider, model) ?? empty
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
