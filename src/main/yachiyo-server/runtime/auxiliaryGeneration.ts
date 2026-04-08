import type { ToolSet } from 'ai'

import type { ProviderSettings } from '../../../shared/yachiyo/protocol.ts'
import type { ModelMessage, ModelRuntime, ModelToolCallErrorEvent, ModelUsage } from './types.ts'

export type AuxiliaryGenerationUnavailableReason =
  | 'not-configured'
  | 'missing-api-key'
  | 'missing-model'

export type AuxiliaryTextGenerationResult =
  | {
      status: 'success'
      settings: ProviderSettings
      text: string
      usage?: ModelUsage
    }
  | {
      status: 'unavailable'
      reason: AuxiliaryGenerationUnavailableReason
    }
  | {
      status: 'failed'
      error: string
      settings: ProviderSettings
    }

export interface AuxiliaryTextGenerationRequest {
  messages: ModelMessage[]
  signal?: AbortSignal
  /** Optional label propagated to LLM lifecycle logs (e.g. "title", "memory-distill"). */
  purpose?: string
  max_token?: number
  /** Optional tools the model can call during generation. */
  tools?: ToolSet
  /** Optional hook to abort the stream after a tool error. */
  onToolCallError?: (event: ModelToolCallErrorEvent) => 'abort' | 'continue'
  /** Explicit provider settings. When provided, skips the default tool-model lookup. */
  settingsOverride?: ProviderSettings
}

export interface AuxiliaryGenerationService {
  generateText(request: AuxiliaryTextGenerationRequest): Promise<AuxiliaryTextGenerationResult>
}

interface AuxiliaryGenerationServiceDeps {
  createModelRuntime: () => ModelRuntime
  readToolModelSettings: () => ProviderSettings | null
}

function toAbortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason
  if (reason instanceof Error) return reason
  if (reason !== undefined) return new Error(String(reason))
  return new Error('aborted')
}

function resolveUnavailableReason(
  settings: ProviderSettings | null
): AuxiliaryGenerationUnavailableReason | null {
  if (!settings || !settings.providerName.trim()) {
    return 'not-configured'
  }

  if (!settings.apiKey.trim()) {
    return 'missing-api-key'
  }

  if (!settings.model.trim()) {
    return 'missing-model'
  }

  return null
}

export function createAuxiliaryGenerationService(
  deps: AuxiliaryGenerationServiceDeps
): AuxiliaryGenerationService {
  return {
    async generateText(
      request: AuxiliaryTextGenerationRequest
    ): Promise<AuxiliaryTextGenerationResult> {
      const settings = request.settingsOverride ?? deps.readToolModelSettings()
      const unavailableReason = resolveUnavailableReason(settings)

      if (unavailableReason) {
        return {
          status: 'unavailable',
          reason: unavailableReason
        }
      }
      if (!settings) {
        return {
          status: 'unavailable',
          reason: 'not-configured'
        }
      }

      const signal = request.signal ?? new AbortController().signal
      const runtime = deps.createModelRuntime()
      const resolvedSettings = settings
      let text = ''
      let usage: ModelUsage | undefined

      try {
        const stream = runtime.streamReply({
          messages: request.messages,
          max_token: request.max_token,
          providerOptionsMode: 'auxiliary',
          settings: resolvedSettings,
          signal,
          purpose: request.purpose ?? 'auxiliary',
          tools: request.tools,
          onToolCallError: request.onToolCallError,
          onFinish: (finishUsage) => {
            usage = finishUsage
          }
        })

        // Race the streaming loop against the abort signal so we never hang
        // past the caller's timeout if the provider transport ignores it.
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(toAbortError(signal))
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(toAbortError(signal))
            },
            { once: true }
          )
        })

        const consume = (async (): Promise<void> => {
          for await (const delta of stream) {
            text += delta
          }
        })()

        await Promise.race([consume, abortPromise])

        return {
          status: 'success',
          settings: resolvedSettings,
          text,
          ...(usage ? { usage } : {})
        }
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          settings: resolvedSettings
        }
      }
    }
  }
}
