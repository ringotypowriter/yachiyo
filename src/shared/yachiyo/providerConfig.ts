import {
  DEFAULT_TOOL_MODEL_MODE,
  type ProviderConfig,
  type SettingsConfig,
  type ToolModelConfig
} from './protocol.ts'

export interface ProviderReference {
  id?: string
  name?: string
}

function normalizeReferenceValue(value: string | undefined): string {
  return value?.trim() ?? ''
}

export function createProviderId(): string {
  return globalThis.crypto.randomUUID()
}

export function ensureProviderId(value: string | undefined): string {
  return normalizeReferenceValue(value) || createProviderId()
}

export function sanitizeProviderConfig(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    id: ensureProviderId(provider.id),
    name: provider.name,
    thinkingEnabled: provider.thinkingEnabled !== false,
    apiKey: provider.apiKey.trim(),
    baseUrl: provider.baseUrl.trim(),
    modelList: {
      enabled: [...new Set(provider.modelList.enabled.filter(Boolean))],
      disabled: [...new Set(provider.modelList.disabled.filter(Boolean))]
    }
  }
}

export function getProviderModels(provider: ProviderConfig | null | undefined): string[] {
  if (!provider) {
    return []
  }

  return [...new Set([...provider.modelList.enabled, ...provider.modelList.disabled])]
}

export function getToolModelConfig(
  config: { toolModel?: ToolModelConfig | null } | Pick<SettingsConfig, 'toolModel'>
): Required<ToolModelConfig> {
  return {
    mode: config.toolModel?.mode ?? DEFAULT_TOOL_MODEL_MODE,
    providerId: config.toolModel?.providerId ?? '',
    providerName: config.toolModel?.providerName ?? '',
    model: config.toolModel?.model ?? ''
  }
}

export function createDisabledToolModelConfig(): Required<ToolModelConfig> {
  return {
    mode: 'disabled',
    providerId: '',
    providerName: '',
    model: ''
  }
}

export function createDefaultModeToolModelConfig(): Required<ToolModelConfig> {
  return {
    mode: DEFAULT_TOOL_MODEL_MODE,
    providerId: '',
    providerName: '',
    model: ''
  }
}

export function createProviderConfig(existingNames: readonly string[]): ProviderConfig {
  let index = existingNames.length + 1
  let candidate = `provider-${index}`

  while (existingNames.includes(candidate)) {
    index += 1
    candidate = `provider-${index}`
  }

  return {
    id: createProviderId(),
    name: candidate,
    type: 'openai',
    thinkingEnabled: true,
    apiKey: '',
    baseUrl: '',
    modelList: {
      enabled: [],
      disabled: []
    }
  }
}

export function providerMatchesReference(
  provider: ProviderConfig,
  reference: ProviderReference
): boolean {
  const id = normalizeReferenceValue(reference.id)
  if (id) {
    return provider.id === id
  }

  const name = normalizeReferenceValue(reference.name)
  return name.length > 0 && provider.name === name
}

export function toolModelTargetsProvider(
  toolModel: ToolModelConfig | null | undefined,
  provider: ProviderConfig
): boolean {
  const providerId = normalizeReferenceValue(toolModel?.providerId)
  const providerName = normalizeReferenceValue(toolModel?.providerName)

  return (
    (providerId.length > 0 && provider.id === providerId) ||
    (providerName.length > 0 && provider.name === providerName)
  )
}

export function syncToolModelWithProvider(
  toolModel: ToolModelConfig | null | undefined,
  provider: ProviderConfig
): Required<ToolModelConfig> {
  const currentToolModel = getToolModelConfig({ toolModel })
  const providerModels = getProviderModels(provider)
  const model = providerModels.includes(currentToolModel.model)
    ? currentToolModel.model
    : (providerModels[0] ?? '')

  return {
    ...currentToolModel,
    providerId: provider.id ?? '',
    providerName: provider.name,
    model
  }
}

export function resolveProviderReference(
  providers: readonly ProviderConfig[],
  reference: ProviderReference
): ProviderConfig | null {
  return providers.find((provider) => providerMatchesReference(provider, reference)) ?? null
}

export function resolveToolModelProvider(
  config: Pick<SettingsConfig, 'providers'>,
  toolModel: ToolModelConfig | null | undefined
): ProviderConfig | null {
  if (!toolModel) {
    return null
  }

  return resolveProviderReference(config.providers, {
    id: toolModel.providerId,
    name: toolModel.providerName
  })
}
