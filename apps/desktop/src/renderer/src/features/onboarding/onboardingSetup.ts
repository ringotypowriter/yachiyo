import type { ProviderConfig, SettingsConfig } from '@yachiyo/shared/protocol'
import { createProviderConfig, hasUsableProvider } from '@yachiyo/shared/providerConfig'
import {
  findProviderPreset,
  providerPresets,
  type ProviderPreset
} from '@yachiyo/shared/providerPresets'

/** Per-device "set up later" flag; a fresh install shows the overlay again. */
export const ONBOARDING_DISMISSED_STORAGE_KEY = 'yachiyo.onboarding.dismissed'

/**
 * Presets offered in the first-run flow: everything a plain API key can
 * activate. Vertex/Codex need service accounts or OAuth sessions, and
 * Ollama needs manual model entry with no key — all three complete through
 * the providers settings pane instead.
 */
export function listOnboardingPresets(): readonly ProviderPreset[] {
  return providerPresets.filter(
    (preset) =>
      preset.type !== 'vertex' && preset.type !== 'openai-codex' && preset.key !== 'ollama'
  )
}

export function shouldShowOnboarding(input: {
  config: SettingsConfig | null
  dismissed: boolean
}): boolean {
  if (input.dismissed || input.config === null) return false
  return !hasUsableProvider(input.config)
}

/**
 * Fold the first-run selection into the config: fill the preset provider's
 * API key, enable the chosen model, and make it the default model. Returns a
 * new config; the input is not mutated.
 */
export function applyOnboardingSelection(
  config: SettingsConfig,
  selection: { presetKey: string; apiKey: string; model: string }
): SettingsConfig {
  const preset = findProviderPreset(selection.presetKey)
  const model = selection.model.trim()
  const providers = [...config.providers]
  const index = providers.findIndex((provider) => provider.presetKey === selection.presetKey)

  const base: ProviderConfig =
    index >= 0
      ? providers[index]
      : {
          ...createProviderConfig(
            providers.map((provider) => provider.name),
            preset
          ),
          presetKey: selection.presetKey
        }

  const updated: ProviderConfig = {
    ...base,
    apiKey: selection.apiKey.trim(),
    modelList: {
      ...base.modelList,
      enabled: base.modelList.enabled.includes(model)
        ? base.modelList.enabled
        : [...base.modelList.enabled, model],
      disabled: base.modelList.disabled.filter((entry) => entry !== model)
    }
  }

  if (index >= 0) {
    providers[index] = updated
  } else {
    providers.push(updated)
  }

  return {
    ...config,
    providers,
    defaultModel: { providerName: updated.name, model }
  }
}
