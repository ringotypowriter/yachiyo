import {
  normalizeUserPrompts,
  type NamedSubagentId,
  type ProviderSettings,
  type SettingsConfig,
  type ThreadModelOverride
} from '@yachiyo/shared/protocol'
import {
  createDisabledToolModelConfig,
  resolveToolModelProvider,
  syncToolModelWithProvider
} from '@yachiyo/shared/providerConfig'
import { DEFAULT_SETTINGS_CONFIG } from './settingsDefaults.ts'
import {
  normalizeChatConfig,
  normalizeDefaultModel,
  normalizeGeneralConfig,
  normalizeMemoryConfig,
  normalizeSkillsConfig,
  normalizeSyncConfig,
  normalizeWebSearchConfig,
  normalizeWorkspaceConfig
} from './settingsFeatureNormalization.ts'
import { asRecord } from './settingsNormalizationShared.ts'
import {
  normalizeEssentials,
  normalizeSubagentProfiles,
  normalizeSubagentsConfig
} from './settingsProfileNormalization.ts'
import {
  EMPTY_PROVIDER_SETTINGS,
  normalizeProviders,
  normalizeToolModelConfig,
  resolvePrimaryModel,
  resolvePrimaryProvider,
  toResolvedProviderSettings
} from './settingsProviderNormalization.ts'

export { DEFAULT_SETTINGS_CONFIG }

export function normalizeSettingsConfig(value: unknown): SettingsConfig {
  const input = asRecord(value)
  const { hasProviders, providers } = normalizeProviders(input['providers'])
  const toolModel = normalizeToolModelConfig(input['toolModel'])
  const resolvedToolProvider = resolveToolModelProvider({ providers }, toolModel)
  const defaultModel = normalizeDefaultModel(input['defaultModel'])
  const subagentProfiles = normalizeSubagentProfiles(input['subagentProfiles'])
  const essentials = normalizeEssentials(input['essentials'])
  const subagents = normalizeSubagentsConfig(input['subagents'])

  return {
    ...(defaultModel ? { defaultModel } : {}),
    general: normalizeGeneralConfig(input['general']),
    chat: normalizeChatConfig(input['chat']),
    workspace: normalizeWorkspaceConfig(input['workspace']),
    sync: normalizeSyncConfig(input['sync']),
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
    subagentProfiles,
    ...(essentials.length > 0 ? { essentials } : {}),
    subagents
  }
}

export function toEffectiveProviderSettings(
  config: SettingsConfig,
  modelOverride?: ThreadModelOverride
): ProviderSettings {
  if (!modelOverride) {
    return toProviderSettings(config)
  }

  const provider = config.providers.find((entry) => entry.name === modelOverride.providerName)
  if (!provider) {
    return toProviderSettings(config)
  }

  return toResolvedProviderSettings(provider, modelOverride.model) ?? toProviderSettings(config)
}

export function toProviderSettings(config: SettingsConfig): ProviderSettings {
  const { defaultModel } = config
  if (defaultModel?.providerName && defaultModel?.model) {
    const provider = config.providers.find((entry) => entry.name === defaultModel.providerName)
    if (provider) {
      return toResolvedProviderSettings(provider, defaultModel.model) ?? EMPTY_PROVIDER_SETTINGS
    }
  }

  const provider = resolvePrimaryProvider(config)
  const model = resolvePrimaryModel(provider)
  return toResolvedProviderSettings(provider, model) ?? EMPTY_PROVIDER_SETTINGS
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

  const provider = resolveToolModelProvider(normalizedConfig, toolModel)
  return toResolvedProviderSettings(provider, toolModel.model ?? '')
}

export function toSubagentProviderSettings(
  config: SettingsConfig,
  agentId: NamedSubagentId,
  callingSettings: ProviderSettings
): ProviderSettings {
  const preferredModel = config.subagents?.preferredModels?.[agentId]
  if (!preferredModel) {
    return callingSettings
  }

  const provider = config.providers.find((entry) => entry.name === preferredModel.providerName)
  if (!provider) {
    return callingSettings
  }

  if (!provider.modelList.enabled.includes(preferredModel.model)) {
    return callingSettings
  }

  return toResolvedProviderSettings(provider, preferredModel.model) ?? callingSettings
}
