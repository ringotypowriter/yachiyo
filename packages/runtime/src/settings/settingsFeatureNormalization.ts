import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
  DEFAULT_WEB_SEARCH_PROVIDER,
  normalizeActiveRunEnterBehavior,
  normalizeSidebarVisibility,
  normalizeThemeAppearance,
  normalizeThemeId,
  type ActivityTrackingConfig,
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
} from '@yachiyo/shared/protocol'
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
    sidebarPreview: normalizeOptionalBool(input['sidebarPreview'], true),
    workSummary: normalizeOptionalBool(input['workSummary'], true),
    themeId: normalizeThemeId(input['themeId'], DEFAULT_SETTINGS_CONFIG.general?.themeId),
    themeAppearance: normalizeThemeAppearance(
      input['themeAppearance'],
      DEFAULT_SETTINGS_CONFIG.general?.themeAppearance
    ),
    demoMode: normalizeOptionalBool(input['demoMode'], false),
    preventSystemSleep: normalizeOptionalBool(input['preventSystemSleep'], false),
    notifyRunCompleted: normalizeOptionalBool(input['notifyRunCompleted'], true),
    notifyCodingTaskStarted: normalizeOptionalBool(input['notifyCodingTaskStarted'], true),
    notifyCodingTaskFinished: normalizeOptionalBool(input['notifyCodingTaskFinished'], true),
    translatorShortcut: normalizeString(
      input['translatorShortcut'],
      DEFAULT_SETTINGS_CONFIG.general?.translatorShortcut ?? 'CommandOrControl+Shift+T'
    ),
    jotdownShortcut: normalizeString(
      input['jotdownShortcut'],
      DEFAULT_SETTINGS_CONFIG.general?.jotdownShortcut ?? 'CommandOrControl+Shift+J'
    )
  }

  const rawChannel = input['updateChannel']
  if (rawChannel === 'stable' || rawChannel === 'beta') {
    result.updateChannel = rawChannel
  } else if (rawChannel === 'nightly') {
    result.updateChannel = 'beta'
  }

  const uiFontSize = normalizePositiveInt(input['uiFontSize'])
  const chatFontSize = normalizePositiveInt(input['chatFontSize'])
  if (uiFontSize !== undefined) result.uiFontSize = uiFontSize
  if (chatFontSize !== undefined) result.chatFontSize = chatFontSize

  const activityTracking = normalizeActivityTrackingConfig(
    input['activityTracking'],
    DEFAULT_SETTINGS_CONFIG.general?.activityTracking
  )
  if (activityTracking) {
    result.activityTracking = activityTracking
  }

  return result
}

function cloneActivityTrackingConfig(config: ActivityTrackingConfig): ActivityTrackingConfig {
  return {
    mode: config.mode,
    ...(config.accessibilityDenied === true ? { accessibilityDenied: true } : {}),
    ...(config.ocr
      ? {
          ocr: {
            enabled: config.ocr.enabled === true,
            excludedApps: [...(config.ocr.excludedApps ?? [])]
          }
        }
      : {})
  }
}

function normalizeActivityTrackingConfig(
  value: unknown,
  fallback?: ActivityTrackingConfig
): ActivityTrackingConfig | undefined {
  const input = asRecord(value)
  const rawMode = input['mode']
  if (rawMode !== 'off' && rawMode !== 'simple' && rawMode !== 'full') {
    // Input missing or invalid — apply the default if available
    return fallback ? cloneActivityTrackingConfig(fallback) : undefined
  }
  const fallbackOcr = fallback?.ocr
  const ocrInput = asRecord(input['ocr'])
  const excludedApps = normalizeStringList(ocrInput['excludedApps'])
  const result: ActivityTrackingConfig = {
    mode: rawMode,
    ocr: {
      enabled: normalizeOptionalBool(ocrInput['enabled'], fallbackOcr?.enabled ?? false),
      excludedApps: excludedApps.length > 0 ? excludedApps : [...(fallbackOcr?.excludedApps ?? [])]
    }
  }
  if (input['accessibilityDenied'] === true) {
    result.accessibilityDenied = true
  }
  return result
}
export function normalizeChatConfig(value: unknown): ChatConfig {
  const input = asRecord(value)

  return {
    activeRunEnterBehavior: normalizeActiveRunEnterBehavior(
      input['activeRunEnterBehavior'],
      DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
    ),
    stripCompact: normalizeOptionalBool(input['stripCompact'], true),
    stripCompactThresholdTokens:
      normalizePositiveInt(input['stripCompactThresholdTokens']) ??
      DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
    autoMemoryDistillation: normalizeOptionalBool(input['autoMemoryDistillation'], true),
    inputBufferEnabled: normalizeOptionalBool(input['inputBufferEnabled'], false),
    recapEnabled: normalizeOptionalBool(input['recapEnabled'], true),
    ...normalizeImageToTextModel(input['imageToTextModel'])
  }
}

function normalizeImageToTextModel(value: unknown): Pick<ChatConfig, 'imageToTextModel'> {
  const input = asRecord(value)
  const providerName = normalizeString(input['providerName'], '')
  const model = normalizeString(input['model'], '')
  if (!providerName || !model) return {}
  return { imageToTextModel: { providerName, model } }
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
  const markdownApp = normalizeString(
    input['markdownApp'] !== undefined ? input['markdownApp'] : (fallback.markdownApp ?? ''),
    ''
  )

  const rawLabels = asRecord(input['pathLabels'] ?? fallback.pathLabels)
  const pathLabels: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawLabels)) {
    if (typeof v === 'string' && v) pathLabels[k] = v
  }

  return {
    savedPaths: normalizeStringList(input['savedPaths'] ?? fallback.savedPaths),
    ...(Object.keys(pathLabels).length > 0 ? { pathLabels } : {}),
    ...(editorApp ? { editorApp } : {}),
    ...(terminalApp ? { terminalApp } : {}),
    ...(markdownApp ? { markdownApp } : {})
  }
}

export function normalizeSkillsConfig(
  value: unknown,
  fallback: SkillsConfig = DEFAULT_SETTINGS_CONFIG.skills ?? {}
): SkillsConfig {
  const input = asRecord(value)

  const disabled = normalizeStringList(input['disabled'] ?? fallback.disabled)
  return {
    enabled: normalizeStringList(input['enabled'] ?? fallback.enabled),
    ...(disabled.length > 0 ? { disabled } : {})
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
    enabled: normalizeOptionalBool(input['enabled'], fallback.enabled ?? true),
    autoRecall: normalizeOptionalBool(input['autoRecall'], fallback.autoRecall ?? true)
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
