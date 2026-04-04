import {
  normalizeUserEnabledTools,
  normalizeUserPrompts,
  type ProviderSettings,
  type SettingsConfig,
  type ThreadModelOverride
} from '../../../shared/yachiyo/protocol.ts'
import {
  createDisabledToolModelConfig,
  resolveToolModelProvider,
  syncToolModelWithProvider
} from '../../../shared/yachiyo/providerConfig.ts'
import { createPresetProviders } from '../../../shared/yachiyo/providerPresets.ts'
import { DEFAULT_SETTINGS_CONFIG } from './settingsDefaults.ts'
import {
  normalizeChatConfig,
  normalizeDefaultModel,
  normalizeGeneralConfig,
  normalizeMemoryConfig,
  normalizeSkillsConfig,
  normalizeWebSearchConfig,
  normalizeWorkspaceConfig
} from './settingsFeatureNormalization.ts'
import { asRecord } from './settingsNormalizationShared.ts'
import { normalizeEssentials, normalizeSubagentProfiles } from './settingsProfileNormalization.ts'
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

  return {
    ...(defaultModel ? { defaultModel } : {}),
    enabledTools: normalizeUserEnabledTools(
      input['enabledTools'],
      DEFAULT_SETTINGS_CONFIG.enabledTools
    ),
    general: normalizeGeneralConfig(input['general']),
    chat: normalizeChatConfig(input['chat']),
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
    providers: hasProviders ? providers : createPresetProviders(),
    prompts: normalizeUserPrompts(input['prompts']),
    subagentProfiles,
    ...(essentials.length > 0 ? { essentials } : {})
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
