import type { ProviderSettings } from '../../../../../shared/yachiyo/protocol.ts'
import type { ModelMessage, ModelRuntime } from '../../../runtime/models/types.ts'

export async function collectStreamText(
  runtime: ModelRuntime,
  input: {
    messages: ModelMessage[]
    providerOptionsMode?: 'default' | 'auxiliary'
    settings: ProviderSettings
    signal?: AbortSignal
  }
): Promise<string> {
  const signal = input.signal ?? new AbortController().signal
  let text = ''

  for await (const delta of runtime.streamReply({
    messages: input.messages,
    providerOptionsMode: input.providerOptionsMode,
    settings: input.settings,
    signal,
    purpose: 'memory-generation'
  })) {
    text += delta
  }

  return text
}

export function isProviderSettingsConfigured(settings: ProviderSettings): boolean {
  return Boolean(settings.providerName.trim() && settings.model.trim() && settings.apiKey.trim())
}
