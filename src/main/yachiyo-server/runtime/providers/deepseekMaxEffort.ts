import type { ProviderSettings } from '../../../../shared/yachiyo/protocol'

type SupportedProvider = Extract<ProviderSettings['provider'], 'openai' | 'anthropic'>

const TARGET_MODEL_SUFFIX = 'deepseek-v4-pro'

export function isDeepSeekV4ProMaxEffortModel(model: string): boolean {
  return model.trim().toLowerCase().endsWith(TARGET_MODEL_SUFFIX)
}

function getRequestPath(input: Parameters<typeof globalThis.fetch>[0]): string {
  const rawUrl = input instanceof Request ? input.url : String(input)
  try {
    return new URL(rawUrl).pathname
  } catch {
    return rawUrl
  }
}

function addMaxEffort(
  provider: SupportedProvider,
  path: string,
  body: Record<string, unknown>
): Record<string, unknown> {
  if (provider === 'openai' && path.endsWith('/chat/completions')) {
    return { ...body, reasoning_effort: 'max' }
  }

  if (provider === 'anthropic' && path.endsWith('/messages')) {
    const outputConfig =
      body.output_config != null && typeof body.output_config === 'object'
        ? (body.output_config as Record<string, unknown>)
        : {}
    return {
      ...body,
      output_config: {
        ...outputConfig,
        effort: 'max'
      }
    }
  }

  return body
}

export function createDeepSeekV4ProMaxEffortFetch(
  settings: Pick<ProviderSettings, 'model' | 'thinkingEnabled'> & { provider: SupportedProvider },
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  if (settings.thinkingEnabled === false || !isDeepSeekV4ProMaxEffortModel(settings.model)) {
    return baseFetch
  }

  return async (input, init) => {
    if (init?.body && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>
      const path = getRequestPath(input)
      init = { ...init, body: JSON.stringify(addMaxEffort(settings.provider, path, body)) }
    }

    return baseFetch(input, init)
  }
}
