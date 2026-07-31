import type { SettingsConfig } from '@yachiyo/shared/protocol'

import type { ProviderCredentialSnapshot } from './providerCredentialVault.ts'

export function extractProviderCredentials(config: SettingsConfig): ProviderCredentialSnapshot {
  const credentials: ProviderCredentialSnapshot = {}

  for (const provider of config.providers) {
    if (!provider.id) {
      throw new Error(`Provider "${provider.name}" is missing a stable id`)
    }

    const apiKey = provider.apiKey.trim()
    const serviceAccountPrivateKey = provider.serviceAccountPrivateKey?.trim()
    if (apiKey || serviceAccountPrivateKey) {
      credentials[provider.id] = {
        ...(apiKey ? { apiKey } : {}),
        ...(serviceAccountPrivateKey ? { serviceAccountPrivateKey } : {})
      }
    }
  }

  return credentials
}

export function mergeProviderCredentials(
  stored: ProviderCredentialSnapshot,
  incoming: ProviderCredentialSnapshot
): ProviderCredentialSnapshot {
  const merged = structuredClone(stored)
  for (const [providerId, credentials] of Object.entries(incoming)) {
    merged[providerId] = { ...merged[providerId], ...credentials }
  }
  return merged
}

export function stripProviderCredentials(config: SettingsConfig): SettingsConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: '',
      serviceAccountPrivateKey: ''
    }))
  }
}

export function hydrateProviderCredentials(
  config: SettingsConfig,
  credentials: ProviderCredentialSnapshot
): SettingsConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => {
      if (!provider.id) {
        throw new Error(`Provider "${provider.name}" is missing a stable id`)
      }
      const stored = credentials[provider.id]
      return {
        ...provider,
        apiKey: stored?.apiKey ?? provider.apiKey,
        serviceAccountPrivateKey:
          stored?.serviceAccountPrivateKey ?? provider.serviceAccountPrivateKey
      }
    })
  }
}
