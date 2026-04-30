import {
  DEFAULT_TOOL_MODEL_MODE,
  type ProviderConfig,
  type SettingsConfig,
  type ThreadModelOverride,
  type ToolModelConfig
} from './protocol.ts'
import type { ProviderPreset } from './providerPresets.ts'

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
    ...(provider.codexSessionPath !== undefined
      ? { codexSessionPath: provider.codexSessionPath.trim() }
      : {}),
    modelList: {
      enabled: [...new Set(provider.modelList.enabled.filter(Boolean))],
      disabled: [...new Set(provider.modelList.disabled.filter(Boolean))],
      ...(provider.modelList.imageIncapable !== undefined
        ? { imageIncapable: [...new Set(provider.modelList.imageIncapable.filter(Boolean))] }
        : {})
    }
  }
}

export function getProviderModels(provider: ProviderConfig | null | undefined): string[] {
  if (!provider) {
    return []
  }

  return [...new Set([...provider.modelList.enabled, ...provider.modelList.disabled])]
}

const KNOWN_IMAGE_INCAPABLE_PATTERNS: string[] = [
  // DeepSeek — all current models are text-only
  'deepseek-chat',
  'deepseek-coder',
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-v2',
  'deepseek-v3',
  'deepseek-v4',
  // Mistral text-only (pixtral-* is vision-capable, mistral-small 25.01+ has vision)
  'codestral',
  'ministral',
  'mistral-large',
  'mistral-nemo',
  'mistral-medium',
  'mistral-tiny',
  // Qwen text-only (qwen-vl / qwen2-vl are vision-capable)
  'qwq',
  'qwen-turbo',
  'qwen-plus',
  'qwen-max',
  'qwen-long',
  'qwen2.5-coder',
  'qwen3',
  // Google text-only
  'gemma',
  // Zhipu GLM text-only (glm-4v is vision-capable)
  'glm-4-',
  'glm-5',
  // Older OpenAI completions
  'gpt-3.5'
]

export function isKnownImageIncapableModel(model: string): boolean {
  const lower = model.toLowerCase()
  return KNOWN_IMAGE_INCAPABLE_PATTERNS.some((pattern) => lower.startsWith(pattern))
}

export function computeImageIncapableForNewModels(
  existingImageIncapable: string[] | undefined,
  allExistingModels: string[],
  newModels: string[]
): string[] | undefined {
  const existingSet = new Set(allExistingModels)
  const current = existingImageIncapable ?? []
  const additions = newModels.filter(
    (m) => !existingSet.has(m) && isKnownImageIncapableModel(m) && !current.includes(m)
  )
  if (additions.length === 0) return existingImageIncapable
  const result = [...current, ...additions]
  return result.length > 0 ? result : undefined
}

export function isModelImageCapable(
  config: Pick<SettingsConfig, 'providers'>,
  providerName: string,
  model: string
): boolean {
  const provider = config.providers.find((p) => p.name === providerName)
  if (!provider) return true
  if (provider.modelList.imageIncapable !== undefined) {
    return !provider.modelList.imageIncapable.includes(model)
  }
  return !isKnownImageIncapableModel(model)
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

export function createProviderConfig(
  existingNames: readonly string[],
  preset?: ProviderPreset
): ProviderConfig {
  const baseName = preset?.name ?? 'provider'
  let candidate = baseName
  let index = 1

  while (existingNames.includes(candidate)) {
    index += 1
    candidate = `${baseName}-${index}`
  }

  return {
    id: createProviderId(),
    name: candidate,
    type: preset?.type ?? 'openai',
    thinkingEnabled: true,
    apiKey: '',
    baseUrl: preset?.baseUrl ?? '',
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

export function modelOverrideTargetsProvider(
  modelOverride: ThreadModelOverride | null | undefined,
  provider: ProviderConfig
): boolean {
  return normalizeReferenceValue(modelOverride?.providerName) === provider.name
}

export function syncModelOverrideWithProvider(
  modelOverride: ThreadModelOverride,
  provider: ProviderConfig
): ThreadModelOverride | undefined {
  const providerModels = getProviderModels(provider)
  const model = providerModels.includes(modelOverride.model)
    ? modelOverride.model
    : (providerModels[0] ?? '')
  if (!model) {
    return undefined
  }

  return {
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
