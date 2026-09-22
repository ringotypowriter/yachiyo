import { createHash } from 'node:crypto'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { cleanBaseUrl, DEFAULT_OPENAI_BASE_URL } from './shared.ts'

export interface ResponsesWebSocketSupportStore {
  isUnsupported(providerId: string, endpoint: string): boolean
  markUnsupported(providerId: string, endpoint: string): void
}

/** Only a digest is persisted: endpoints may contain credentials or query tokens. */
export function responsesEndpointKey(url: string): string {
  const parsed = new URL(url)
  parsed.protocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
  parsed.hash = ''
  return createHash('sha256').update(parsed.toString()).digest('hex')
}

export function createResponsesWebSocketSupportStore(config: {
  read: () => SettingsConfig
  write: (settings: SettingsConfig) => unknown
}): ResponsesWebSocketSupportStore {
  return {
    isUnsupported(providerId, endpoint) {
      return config
        .read()
        .providers.some(
          (provider) =>
            provider.id === providerId &&
            provider.type === 'openai-responses' &&
            provider.responsesWebSocketUnsupportedEndpoint === endpoint
        )
    },
    markUnsupported(providerId, endpoint) {
      const settings = config.read()
      const provider = settings.providers.find((entry) => entry.id === providerId)
      // Ignore a handshake completing after the provider was removed or its endpoint changed.
      if (
        !provider ||
        provider.type !== 'openai-responses' ||
        provider.responsesWebSocket === false ||
        responsesEndpointKey(
          `${cleanBaseUrl(provider.baseUrl, DEFAULT_OPENAI_BASE_URL)}/responses`
        ) !== endpoint ||
        provider.responsesWebSocketUnsupportedEndpoint === endpoint
      )
        return
      provider.responsesWebSocketUnsupportedEndpoint = endpoint
      config.write(settings)
    }
  }
}
