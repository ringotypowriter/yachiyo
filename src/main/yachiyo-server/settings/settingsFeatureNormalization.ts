import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_MEMORY_PROVIDER,
  DEFAULT_WEB_SEARCH_PROVIDER,
  normalizeActiveRunEnterBehavior,
  normalizeMemoryProviderId,
  normalizeOptionalMaxChatToken,
  normalizeSidebarVisibility,
  type BrowserBackedWebSearchSessionConfig,
  type ChatConfig,
  type ExaWebSearchConfig,
  type GeneralConfig,
  type MemoryConfig,
  type SkillsConfig,
  type ThreadModelOverride,
  type WebSearchConfig,
  type WebSearchProviderId,
  type WorkspaceConfig
} from '../../../shared/yachiyo/protocol.ts'
import { DEFAULT_SETTINGS_CONFIG } from './settingsDefaults.ts'
import {
  asRecord,
  normalizeOptionalBool,
  normalizePositiveInt,
  normalizeString,
  normalizeStringList
} from './settingsNormalizationShared.ts'

function normalizeWebSearchProviderId(
  value: unknown,
  fallback: WebSearchProviderId = DEFAULT_WEB_SEARCH_PROVIDER
): WebSearchProviderId {
  return value === 'google-browser' || value === 'exa' ? value : fallback
}

export function normalizeGeneralConfig(value: unknown): GeneralConfig {
  const input = asRecord(value)
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

export function normalizeChatConfig(value: unknown): ChatConfig {
  const input = asRecord(value)

  return {
    activeRunEnterBehavior: normalizeActiveRunEnterBehavior(
      input['activeRunEnterBehavior'],
      DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
    ),
    ...('maxChatToken' in input
      ? {
          maxChatToken: normalizeOptionalMaxChatToken(input['maxChatToken'])
        }
      : {})
  }
}

export function normalizeWorkspaceConfig(
  value: unknown,
  fallback: WorkspaceConfig = DEFAULT_SETTINGS_CONFIG.workspace ?? {}
): WorkspaceConfig {
  const input = asRecord(value)
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

export function normalizeSkillsConfig(
  value: unknown,
  fallback: SkillsConfig = DEFAULT_SETTINGS_CONFIG.skills ?? {}
): SkillsConfig {
  const input = asRecord(value)

  return {
    enabled: normalizeStringList(input['enabled'] ?? fallback.enabled)
  }
}

export function normalizeDefaultModel(value: unknown): ThreadModelOverride | undefined {
  const input = asRecord(value)
  const providerName = normalizeString(input['providerName'], '')
  const model = normalizeString(input['model'], '')

  if (!providerName || !model) {
    return undefined
  }

  return { providerName, model }
}

export function normalizeMemoryConfig(
  value: unknown,
  fallback: MemoryConfig = DEFAULT_SETTINGS_CONFIG.memory ?? {}
): MemoryConfig {
  const input = asRecord(value)

  return {
    enabled: input['enabled'] === true,
    provider: normalizeMemoryProviderId(
      input['provider'],
      fallback.provider ?? DEFAULT_MEMORY_PROVIDER
    ),
    baseUrl: normalizeString(input['baseUrl'], fallback.baseUrl ?? DEFAULT_MEMORY_BASE_URL)
  }
}

export function normalizeBrowserSessionConfig(
  value: unknown,
  fallback: BrowserBackedWebSearchSessionConfig = DEFAULT_SETTINGS_CONFIG.webSearch
    ?.browserSession ?? {}
): BrowserBackedWebSearchSessionConfig {
  const input = asRecord(value)

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

export function normalizeExaWebSearchConfig(
  value: unknown,
  fallback: ExaWebSearchConfig = DEFAULT_SETTINGS_CONFIG.webSearch?.exa ?? {}
): ExaWebSearchConfig {
  const input = asRecord(value)

  return {
    apiKey: normalizeString(input['apiKey'], fallback.apiKey ?? ''),
    baseUrl: normalizeString(input['baseUrl'], fallback.baseUrl ?? '')
  }
}

export function normalizeWebSearchConfig(
  value: unknown,
  fallback: WebSearchConfig = DEFAULT_SETTINGS_CONFIG.webSearch ?? {}
): WebSearchConfig {
  const input = asRecord(value)

  return {
    defaultProvider: normalizeWebSearchProviderId(
      input['defaultProvider'],
      fallback.defaultProvider ?? DEFAULT_WEB_SEARCH_PROVIDER
    ),
    browserSession: normalizeBrowserSessionConfig(input['browserSession'], fallback.browserSession),
    exa: normalizeExaWebSearchConfig(input['exa'], fallback.exa)
  }
}
