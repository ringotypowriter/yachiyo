import {
  DEFAULT_TOOL_MODEL_MODE,
  normalizeToolModelMode,
  type ProviderConfig,
  type ProviderKind,
  type ProviderSettings,
  type SettingsConfig,
  type ToolModelConfig
} from '../../../shared/yachiyo/protocol.ts'
import { ensureProviderId, sanitizeProviderConfig } from '../../../shared/yachiyo/providerConfig.ts'
import { DEFAULT_SETTINGS_CONFIG } from './settingsDefaults.ts'
import {
  asRecord,
  normalizeOptionalBool,
  normalizeString,
  normalizeStringList
} from './settingsNormalizationShared.ts'

function normalizeProviderType(value: unknown, fallback: ProviderKind): ProviderKind {
  return value === 'openai' ||
    value === 'openai-responses' ||
    value === 'openai-codex' ||
    value === 'anthropic' ||
    value === 'gemini' ||
    value === 'vertex' ||
    value === 'vercel-gateway'
    ? value
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

function normalizeProviderConfig(value: unknown, fallback?: ProviderConfig): ProviderConfig | null {
  const input = asRecord(value)
  const name = normalizeString(input['name'], fallback?.name ?? '')

  if (!name) {
    return null
  }

  const modelList = asRecord(input['modelList'])
  const enabled = normalizeStringList(modelList['enabled'])
  const disabled = normalizeStringList(modelList['disabled']).filter(
    (model) => !enabled.includes(model)
  )
  const rawImageIncapable = modelList['imageIncapable']
  const imageIncapable = normalizeStringList(rawImageIncapable)

  const presetKey = normalizeString(input['presetKey'], fallback?.presetKey ?? '')
  const codexSessionPath =
    normalizeString(input['codexSessionPath'], fallback?.codexSessionPath ?? '') || undefined

  return sanitizeProviderConfig({
    id: ensureProviderId(normalizeString(input['id'], fallback?.id ?? '')),
    ...(presetKey ? { presetKey } : {}),
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
    ...(codexSessionPath !== undefined ? { codexSessionPath } : {}),
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
      disabled,
      ...(rawImageIncapable !== undefined ? { imageIncapable } : {})
    }
  })
}

export function normalizeProviders(value: unknown): {
  hasProviders: boolean
  providers: ProviderConfig[]
} {
  const hasProviders = Array.isArray(value)
  const rawProviders = hasProviders ? value : []
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

  return {
    hasProviders,
    providers
  }
}

export function normalizeToolModelConfig(
  value: unknown,
  fallback: ToolModelConfig = DEFAULT_SETTINGS_CONFIG.toolModel ?? {}
): ToolModelConfig {
  const input = asRecord(value)

  return {
    mode: normalizeToolModelMode(input['mode'], fallback.mode ?? DEFAULT_TOOL_MODEL_MODE),
    providerId: normalizeString(input['providerId'], fallback.providerId ?? ''),
    providerName: normalizeString(input['providerName'], fallback.providerName ?? ''),
    model: normalizeString(input['model'], fallback.model ?? '')
  }
}

export function resolvePrimaryProvider(config: SettingsConfig): ProviderConfig | null {
  return (
    config.providers.find((provider) => provider.modelList.enabled.length > 0) ??
    config.providers[0] ??
    null
  )
}

export function resolvePrimaryModel(provider: ProviderConfig | null): string {
  if (!provider) {
    return ''
  }

  return provider.modelList.enabled[0] ?? ''
}

export function toResolvedProviderSettings(
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
    codexSessionPath: provider.codexSessionPath,
    project: provider.project,
    location: provider.location,
    serviceAccountEmail: provider.serviceAccountEmail,
    serviceAccountPrivateKey: provider.serviceAccountPrivateKey
  }
}

export const EMPTY_PROVIDER_SETTINGS: ProviderSettings = {
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
