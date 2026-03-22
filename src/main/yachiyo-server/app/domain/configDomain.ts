import {
  DEFAULT_ENABLED_TOOL_NAMES,
  type ImportWebSearchBrowserSessionInput,
  normalizeEnabledTools,
  type SettingsConfig,
  type SettingsUpdatedEvent,
  type ToolCallName,
  type ToolPreferencesInput,
  type WebSearchBrowserImportSource,
  type WebSearchConfig,
  type MessageImageRecord,
  type ProviderConfig,
  type ProviderSettings
} from '../../../../shared/yachiyo/protocol.ts'
import {
  createProviderId,
  providerMatchesReference,
  sanitizeProviderConfig
} from '../../../../shared/yachiyo/providerConfig.ts'
import { extractBase64DataUrlPayload } from '../../../../shared/yachiyo/messageContent.ts'
import { fetchModels } from '../../runtime/modelRuntime.ts'
import {
  toProviderSettings,
  toToolModelSettings,
  type SettingsStore
} from '../../settings/settingsStore.ts'
import type { EmitServerEvent } from './shared.ts'

export interface WebSearchSettingsDeps {
  importBrowserSession?: (
    input: ImportWebSearchBrowserSessionInput
  ) => Promise<{ importedAt: string; sourceBrowser: 'google-chrome'; sourceProfileName: string }>
  listBrowserImportSources?: () => Promise<WebSearchBrowserImportSource[]>
}

function mergeUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function assertSupportedImages(images: MessageImageRecord[]): void {
  for (const image of images) {
    if (!image.mediaType.startsWith('image/')) {
      throw new Error('Only image inputs are supported right now.')
    }

    const parsedImage = extractBase64DataUrlPayload(image.dataUrl)
    if (!parsedImage || !parsedImage.mediaType.startsWith('image/')) {
      throw new Error('Image input is not ready to send yet.')
    }
  }
}

export function resolveEnabledTools(
  value: unknown,
  fallback: readonly ToolCallName[] = DEFAULT_ENABLED_TOOL_NAMES
): ToolCallName[] {
  return normalizeEnabledTools(value, fallback)
}

function upsertProviderConfig(config: SettingsConfig, provider: ProviderConfig): SettingsConfig {
  const nextProvider = sanitizeProviderConfig({
    ...provider,
    modelList: {
      enabled: mergeUnique(provider.modelList.enabled),
      disabled: mergeUnique(provider.modelList.disabled).filter(
        (model) => !provider.modelList.enabled.includes(model)
      )
    }
  })
  const currentIndex = config.providers.findIndex((entry) =>
    providerMatchesReference(
      entry,
      provider.id?.trim()
        ? { id: nextProvider.id }
        : {
            name: nextProvider.name
          }
    )
  )

  if (currentIndex === -1) {
    return {
      ...config,
      providers: [...config.providers, nextProvider]
    }
  }

  const providers = [...config.providers]
  providers[currentIndex] = nextProvider

  return {
    ...config,
    providers
  }
}

function updateProviderModels(
  config: SettingsConfig,
  input: { name: string; model: string; enabled: boolean }
): SettingsConfig {
  const name = input.name.trim()
  const model = input.model.trim()
  const provider = config.providers.find((entry) => entry.name === name)

  if (!provider) {
    throw new Error(`Unknown provider: ${name}`)
  }

  const nextProvider: ProviderConfig = {
    ...provider,
    modelList: {
      enabled: input.enabled
        ? mergeUnique([...provider.modelList.enabled, model])
        : provider.modelList.enabled.filter((entry) => entry !== model),
      disabled: input.enabled
        ? provider.modelList.disabled.filter((entry) => entry !== model)
        : mergeUnique([model, ...provider.modelList.disabled])
    }
  }

  return upsertProviderConfig(config, nextProvider)
}

export class YachiyoServerConfigDomain {
  private readonly settingsStore: SettingsStore
  private readonly emit: EmitServerEvent
  private readonly webSearchDeps: WebSearchSettingsDeps

  constructor(input: {
    settingsStore: SettingsStore
    emit: EmitServerEvent
    webSearchDeps?: WebSearchSettingsDeps
  }) {
    this.settingsStore = input.settingsStore
    this.emit = input.emit
    this.webSearchDeps = input.webSearchDeps ?? {}
  }

  getConfig(): SettingsConfig {
    return this.readConfig()
  }

  saveConfig(input: SettingsConfig): SettingsConfig {
    return this.persistConfig(input)
  }

  getSettings(): ProviderSettings {
    return this.readSettings()
  }

  saveSettings(input: Partial<ProviderSettings>): ProviderSettings {
    const current = this.readConfig()
    const currentSettings = this.readSettings()
    const providerName =
      input.providerName?.trim() ||
      currentSettings.providerName ||
      input.provider?.trim() ||
      'provider'

    const existing =
      current.providers.find((provider) => provider.name === providerName) ??
      current.providers.find((provider) => provider.type === input.provider)

    const nextProvider: ProviderConfig = {
      id: existing?.id ?? createProviderId(),
      name: providerName,
      type: input.provider ?? existing?.type ?? currentSettings.provider,
      apiKey: input.apiKey?.trim() ?? existing?.apiKey ?? currentSettings.apiKey,
      baseUrl: input.baseUrl?.trim() ?? existing?.baseUrl ?? currentSettings.baseUrl,
      modelList: {
        enabled: mergeUnique([
          ...(existing?.modelList.enabled ?? []),
          input.model?.trim() ?? currentSettings.model
        ]),
        disabled: (existing?.modelList.disabled ?? []).filter(
          (model) => model !== (input.model?.trim() ?? currentSettings.model)
        )
      }
    }

    const baseConfig = upsertProviderConfig(current, nextProvider)
    const prioritizedProvider = baseConfig.providers.find(
      (provider) => provider.name === providerName
    )
    const nextConfig = this.persistConfig({
      ...current,
      providers: prioritizedProvider
        ? [
            prioritizedProvider,
            ...baseConfig.providers.filter((provider) => provider.name !== providerName)
          ]
        : baseConfig.providers
    })

    return toProviderSettings(nextConfig)
  }

  saveToolPreferences(input: ToolPreferencesInput): SettingsConfig {
    const current = this.readConfig()
    return this.persistConfig({
      ...current,
      enabledTools: resolveEnabledTools(input.enabledTools, current.enabledTools)
    })
  }

  async listWebSearchBrowserImportSources(): Promise<WebSearchBrowserImportSource[]> {
    return this.webSearchDeps.listBrowserImportSources?.() ?? []
  }

  async importWebSearchBrowserSession(
    input: ImportWebSearchBrowserSessionInput
  ): Promise<SettingsConfig> {
    if (!this.webSearchDeps.importBrowserSession) {
      throw new Error('Browser-backed web search session import is not configured.')
    }

    const imported = await this.webSearchDeps.importBrowserSession(input)
    const current = this.readConfig()
    const nextWebSearch: WebSearchConfig = {
      ...current.webSearch,
      browserSession: {
        ...current.webSearch?.browserSession,
        sourceBrowser: imported.sourceBrowser,
        sourceProfileName: imported.sourceProfileName,
        importedAt: imported.importedAt,
        lastImportError: ''
      }
    }

    return this.persistConfig({
      ...current,
      webSearch: nextWebSearch
    })
  }

  upsertProvider(input: ProviderConfig): ProviderConfig {
    const nextConfig = this.persistConfig(upsertProviderConfig(this.readConfig(), input))
    const provider = nextConfig.providers.find((entry) =>
      providerMatchesReference(
        entry,
        input.id?.trim()
          ? { id: input.id }
          : {
              name: input.name
            }
      )
    )
    if (!provider) {
      throw new Error(`Unknown provider: ${input.name}`)
    }
    return provider
  }

  removeProvider(input: { name: string }): SettingsConfig {
    const name = input.name.trim()
    const current = this.readConfig()
    const providers = current.providers.filter((provider) => provider.name !== name)

    if (providers.length === current.providers.length) {
      throw new Error(`Unknown provider: ${name}`)
    }

    return this.persistConfig({
      ...current,
      providers
    })
  }

  enableProviderModel(input: { name: string; model: string }): SettingsConfig {
    return this.persistConfig(
      updateProviderModels(this.readConfig(), {
        ...input,
        enabled: true
      })
    )
  }

  disableProviderModel(input: { name: string; model: string }): SettingsConfig {
    return this.persistConfig(
      updateProviderModels(this.readConfig(), {
        ...input,
        enabled: false
      })
    )
  }

  async fetchProviderModels(input: ProviderConfig): Promise<string[]> {
    console.log('[fetchProviderModels] called with:', {
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl || '(default)',
      hasApiKey: Boolean(input.apiKey?.trim())
    })
    const models = await fetchModels(input)
    console.log('[fetchProviderModels] result:', models.length, 'models', models.slice(0, 5))
    return models
  }

  readSettings(): ProviderSettings {
    return toProviderSettings(this.readConfig())
  }

  readToolModelSettings(): ProviderSettings | null {
    return toToolModelSettings(this.readConfig())
  }

  readConfig(): SettingsConfig {
    return this.settingsStore.read()
  }

  private persistConfig(input: SettingsConfig): SettingsConfig {
    this.settingsStore.write(input)
    const config = this.readConfig()
    this.emit<SettingsUpdatedEvent>({
      type: 'settings.updated',
      config,
      settings: toProviderSettings(config)
    })
    return config
  }
}
