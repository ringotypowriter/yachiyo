import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import TOML from 'smol-toml'

import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_MEMORY_PROVIDER,
  DEFAULT_ENABLED_TOOL_NAMES,
  DEFAULT_MAX_CHAT_TOKEN,
  DEFAULT_SIDEBAR_VISIBILITY,
  DEFAULT_TOOL_MODEL_MODE,
  normalizeMemoryProviderId,
  normalizeActiveRunEnterBehavior,
  normalizeMaxChatToken,
  normalizeOptionalMaxChatToken,
  normalizeUserEnabledTools,
  normalizeSidebarVisibility,
  normalizeToolModelMode,
  normalizeUserPrompts,
  type BrowserBackedWebSearchSessionConfig,
  type EssentialPreset,
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
    activeRunEnterBehavior: DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
    maxChatToken: DEFAULT_MAX_CHAT_TOKEN
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
  const rawChannel = input['updateChannel']
  if (rawChannel === 'stable' || rawChannel === 'nightly') {
    result.updateChannel = rawChannel
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
  const editorApp = normalizeString(
    input['editorApp'] !== undefined ? input['editorApp'] : (fallback.editorApp ?? ''),
    ''
  )
  const terminalApp = normalizeString(
    input['terminalApp'] !== undefined ? input['terminalApp'] : (fallback.terminalApp ?? ''),
    ''
  )

  return {
    savedPaths: normalizeStringList(input['savedPaths'] ?? fallback.savedPaths),
    ...(editorApp ? { editorApp } : {}),
    ...(terminalApp ? { terminalApp } : {})
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
    thinkingEnabled: normalizeOptionalBool(
      input['thinkingEnabled'],
      fallback?.thinkingEnabled !== false
    ),
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
    thinkingEnabled: provider.thinkingEnabled !== false,
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

function normalizeEssentialPreset(value: unknown): EssentialPreset | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const id = normalizeString(input['id'], '')
  const icon = normalizeString(input['icon'], '')
  if (!id) return null

  const iconType = input['iconType'] === 'image' ? 'image' : 'emoji'
  const label = normalizeString(input['label'], '') || undefined
  const workspacePath = normalizeString(input['workspacePath'], '') || undefined
  const privacyMode = typeof input['privacyMode'] === 'boolean' ? input['privacyMode'] : undefined
  const order = typeof input['order'] === 'number' ? input['order'] : 0

  let modelOverride: ThreadModelOverride | undefined
  if (input['modelOverride'] && typeof input['modelOverride'] === 'object') {
    const mo = input['modelOverride'] as Record<string, unknown>
    const providerName = normalizeString(mo['providerName'], '')
    const model = normalizeString(mo['model'], '')
    if (providerName && model) {
      modelOverride = { providerName, model }
    }
  }

  return {
    id,
    icon,
    iconType,
    label,
    workspacePath,
    ...(privacyMode === undefined ? {} : { privacyMode }),
    modelOverride,
    order
  }
}

function normalizeEssentials(value: unknown): EssentialPreset[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const preset = normalizeEssentialPreset(item)
    return preset ? [preset] : []
  })
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

  const essentials = normalizeEssentials(input['essentials'])

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
      ),
      ...(input['chat'] &&
      typeof input['chat'] === 'object' &&
      'maxChatToken' in (input['chat'] as Record<string, unknown>)
        ? {
            maxChatToken: normalizeOptionalMaxChatToken(
              (input['chat'] as Record<string, unknown>)['maxChatToken']
            )
          }
        : {})
    },
    workspace: normalizeWorkspaceConfig(input['workspace']),
    skills: normalizeSkillsConfig(input['skills']),
    toolModel:
      toolModel.mode === 'custom'
        ? resolvedToolProvider
          ? syncToolModelWithProvider(toolModel, resolvedToolProvider)
          : createDisabledToolModelConfig()
        : toolModel, // 'default' and 'disabled' pass through — no provider resolution needed
    memory: normalizeMemoryConfig(input['memory']),
    webSearch: normalizeWebSearchConfig(input['webSearch']),
    providers: hasProviders ? providers : DEFAULT_SETTINGS_CONFIG.providers,
    prompts: normalizeUserPrompts(input['prompts']),
    subagentProfiles,
    ...(essentials.length > 0 ? { essentials } : {})
  }
}

/**
 * Quote a TOML bare key only when it contains characters that are not
 * allowed in a bare key (A-Za-z0-9, `-`, `_`).  Keys like `foo.bar`
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
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${tomlKey(k)} = ${JSON.stringify(v)}`)
        .join(', ')
      return `${prefix}{ ${pairs} }`
    }
  )
}

export function parseSettingsToml(raw: string): SettingsConfig {
  const doc = TOML.parse(fixLegacyJsonEnv(raw))
  return normalizeSettingsConfig(doc)
}

export function stringifySettingsToml(config: SettingsConfig): string {
  const normalized = normalizeSettingsConfig(config)
  const toolModel = normalizeToolModelConfig(normalized.toolModel)
  const memory = normalizeMemoryConfig(normalized.memory)

  const general: Record<string, unknown> = {
    sidebarVisibility: normalizeSidebarVisibility(
      normalized.general?.sidebarVisibility,
      DEFAULT_SETTINGS_CONFIG.general?.sidebarVisibility
    ),
    notifyRunCompleted: normalized.general?.notifyRunCompleted !== false,
    notifyCodingTaskStarted: normalized.general?.notifyCodingTaskStarted !== false,
    notifyCodingTaskFinished: normalized.general?.notifyCodingTaskFinished !== false
  }
  if (normalized.general?.updateChannel != null)
    general.updateChannel = normalized.general.updateChannel
  if (normalized.general?.uiFontSize != null) general.uiFontSize = normalized.general.uiFontSize
  if (normalized.general?.chatFontSize != null)
    general.chatFontSize = normalized.general.chatFontSize

  const doc: Record<string, unknown> = {
    enabledTools: normalizeUserEnabledTools(
      normalized.enabledTools,
      DEFAULT_SETTINGS_CONFIG.enabledTools
    ),
    general,
    chat: {
      activeRunEnterBehavior: normalizeActiveRunEnterBehavior(
        normalized.chat?.activeRunEnterBehavior,
        DEFAULT_SETTINGS_CONFIG.chat?.activeRunEnterBehavior
      ),
      ...(normalized.chat?.maxChatToken != null
        ? {
            maxChatToken: normalizeMaxChatToken(
              normalized.chat.maxChatToken,
              DEFAULT_SETTINGS_CONFIG.chat?.maxChatToken
            )
          }
        : {})
    },
    workspace: {
      savedPaths: normalized.workspace?.savedPaths ?? [],
      editorApp: normalized.workspace?.editorApp ?? '',
      terminalApp: normalized.workspace?.terminalApp ?? ''
    },
    skills: {
      enabled: normalized.skills?.enabled ?? []
    },
    toolModel: {
      mode: toolModel.mode ?? DEFAULT_TOOL_MODEL_MODE,
      providerId: toolModel.providerId ?? '',
      providerName: toolModel.providerName ?? '',
      model: toolModel.model ?? ''
    },
    defaultModel: {
      providerName: normalized.defaultModel?.providerName ?? '',
      model: normalized.defaultModel?.model ?? ''
    },
    memory: {
      enabled: memory.enabled,
      provider: memory.provider ?? DEFAULT_MEMORY_PROVIDER,
      baseUrl: memory.baseUrl ?? DEFAULT_MEMORY_BASE_URL
    },
    webSearch: {
      defaultProvider: normalizeWebSearchProviderId(normalized.webSearch?.defaultProvider),
      browserSession: {
        sourceBrowser: normalized.webSearch?.browserSession?.sourceBrowser ?? '',
        sourceProfileName: normalized.webSearch?.browserSession?.sourceProfileName ?? '',
        importedAt: normalized.webSearch?.browserSession?.importedAt ?? '',
        lastImportError: normalized.webSearch?.browserSession?.lastImportError ?? ''
      },
      exa: {
        apiKey: normalized.webSearch?.exa?.apiKey ?? '',
        baseUrl: normalized.webSearch?.exa?.baseUrl ?? ''
      }
    },
    providers: normalized.providers.map((provider) => ({
      id: ensureProviderId(provider.id),
      name: provider.name,
      type: provider.type,
      thinkingEnabled: provider.thinkingEnabled !== false,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      project: provider.project ?? '',
      location: provider.location ?? '',
      serviceAccountEmail: provider.serviceAccountEmail ?? '',
      serviceAccountPrivateKey: provider.serviceAccountPrivateKey ?? '',
      modelList: {
        enabled: provider.modelList.enabled,
        disabled: provider.modelList.disabled
      }
    })),
    prompts: (normalized.prompts ?? []).map((prompt) => ({
      keycode: prompt.keycode,
      text: prompt.text
    })),
    subagentProfiles: (normalized.subagentProfiles ?? []).map((profile) => ({
      id: profile.id,
      name: profile.name,
      enabled: profile.enabled,
      description: profile.description,
      command: profile.command,
      args: profile.args,
      env: profile.env
    })),
    essentials: (normalized.essentials ?? []).map((essential) => {
      const entry: Record<string, unknown> = {
        id: essential.id,
        icon: essential.icon,
        iconType: essential.iconType,
        label: essential.label ?? '',
        workspacePath: essential.workspacePath ?? '',
        order: essential.order
      }
      if (essential.privacyMode !== undefined) entry.privacyMode = essential.privacyMode
      if (essential.modelOverride) {
        entry.modelOverride = {
          providerName: essential.modelOverride.providerName,
          model: essential.modelOverride.model
        }
      }
      return entry
    })
  }

  return TOML.stringify(doc)
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
    thinkingEnabled: true,
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

  if (toolModel.mode === 'default') {
    return toProviderSettings(config)
  }

  // mode === 'custom'
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
