import { stepCountIs } from 'ai'

import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelRuntime } from './types.ts'
import {
  type AiSdkRuntimeDependencies,
  type FetchModelsDependencies,
  resolveAiSdkRuntimeDependencies
} from './providers/dependencies.ts'
import { fetchModels as fetchModelsImpl } from './providers/fetchModels.ts'
import { assertConfigured, createLanguageModel } from './providers/languageModel.ts'
import {
  logGatewayDiagnostics,
  shouldLogGatewayDiagnostics,
  toSerializableError
} from './providers/gateway.ts'
import { createProviderOptions } from './providers/providerOptions.ts'
import { isRetryableModelError } from './retryableModelError.ts'
import { sleep } from '../channels/connectionRetry.ts'

/** Disable AI SDK's built-in retry — we handle retries ourselves. */
const SDK_MAX_RETRIES = 0

export const RETRY_MAX_ATTEMPTS = 10
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000

function readTextDelta(part: { delta?: string; text?: string; textDelta?: string }): string | null {
  return part.delta ?? part.textDelta ?? part.text ?? null
}

export async function fetchModels(
  provider: import('../../../shared/yachiyo/protocol').ProviderConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  dependencies: FetchModelsDependencies = {}
): Promise<string[]> {
  return fetchModelsImpl(provider, fetchImpl, dependencies)
}

export function createAiSdkModelRuntime(dependencies: AiSdkRuntimeDependencies = {}): ModelRuntime {
  const resolvedDependencies = resolveAiSdkRuntimeDependencies(dependencies)

  return {
    async *streamReply(request) {
      assertConfigured(request.settings)

      const preparedMessages = prepareAiSdkMessages(request.messages)
      const providerOptions = createProviderOptions(
        request.settings,
        request.providerOptionsMode ?? 'default'
      )

      if (shouldLogGatewayDiagnostics(request.settings)) {
        logGatewayDiagnostics('streamReply-input', {
          model: request.settings.model,
          providerOptions,
          toolNames: request.tools ? Object.keys(request.tools) : []
        })
      }

      const finishedToolCallIds = new Set<string>()
      const toolCallContextById = new Map<string, { input: unknown; toolName: string }>()
      const toolCallFinishCallback = request.onToolCallFinish
      const emitToolCallFinish = toolCallFinishCallback
        ? (event: Parameters<NonNullable<typeof toolCallFinishCallback>>[0]) => {
            const toolCallId = event.toolCall.toolCallId
            if (finishedToolCallIds.has(toolCallId)) {
              return
            }

            finishedToolCallIds.add(toolCallId)

            try {
              return toolCallFinishCallback(event)
            } catch (error) {
              finishedToolCallIds.delete(toolCallId)
              throw error
            }
          }
        : undefined

      let retryDelay = RETRY_BASE_DELAY_MS

      for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
        // Once user-visible assistant text or tool activity has started, the
        // attempt is committed and must not be retried.
        let streamCommitted = false

        try {
          const result = resolvedDependencies.streamTextImpl({
            abortSignal: request.signal,
            maxRetries: SDK_MAX_RETRIES,
            messages: preparedMessages,
            model: createLanguageModel(
              request.settings,
              resolvedDependencies,
              request.providerOptionsMode
            ),
            providerOptions,
            ...(request.max_token != null ? { maxOutputTokens: request.max_token } : {}),
            ...(request.tools
              ? {
                  tools: request.tools,
                  stopWhen: stepCountIs(request.maxToolSteps ?? 100)
                }
              : {}),
            ...(request.onToolCallStart
              ? { experimental_onToolCallStart: request.onToolCallStart }
              : {}),
            ...(emitToolCallFinish ? { experimental_onToolCallFinish: emitToolCallFinish } : {})
          })

          if ('fullStream' in result && result.fullStream) {
            for await (const part of result.fullStream as AsyncIterable<{
              errorText?: string
              finishReason?: string
              input?: unknown
              inputTextDelta?: string
              isContinued?: boolean
              output?: unknown
              error?: unknown
              preliminary?: boolean
              stepNumber?: number
              text?: string
              toolCallId?: string
              toolName?: string
              type: string
            }>) {
              if (part.type === 'step-finish' || part.type === 'finish') {
                console.log(
                  `[yachiyo][stream] ${part.type}: finishReason=${part.finishReason ?? 'unknown'}, step=${part.stepNumber ?? '?'}, isContinued=${part.isContinued ?? false}`
                )
              }

              if (part.type === 'error') {
                throw part.error instanceof Error
                  ? part.error
                  : new Error(String(part.error ?? 'Unknown stream error'))
              }

              if (
                (part.type === 'reasoning' ||
                  part.type === 'reasoning-delta' ||
                  part.type === 'reasoning-part-finish') &&
                readTextDelta(part)
              ) {
                request.onReasoningDelta?.(readTextDelta(part) as string)
                continue
              }

              if (part.type === 'text-delta' && readTextDelta(part)) {
                streamCommitted = true
                yield readTextDelta(part) as string
                continue
              }

              if (
                part.type === 'tool-input-available' &&
                typeof part.toolCallId === 'string' &&
                typeof part.toolName === 'string'
              ) {
                streamCommitted = true
                toolCallContextById.set(part.toolCallId, {
                  input: part.input,
                  toolName: part.toolName
                })
                continue
              }

              if (part.type === 'tool-input-error' && typeof part.toolCallId === 'string') {
                toolCallContextById.delete(part.toolCallId)
                continue
              }

              if (
                (part.type === 'tool-output-available' || part.type === 'tool-result') &&
                part.preliminary === true &&
                request.onToolCallUpdate &&
                typeof part.toolCallId === 'string'
              ) {
                const toolCallContext =
                  (typeof part.toolName === 'string'
                    ? { input: part.input, toolName: part.toolName }
                    : undefined) ?? toolCallContextById.get(part.toolCallId)

                if (!toolCallContext) {
                  continue
                }

                request.onToolCallUpdate({
                  output: part.output,
                  toolCall: {
                    input: toolCallContext.input,
                    toolCallId: part.toolCallId,
                    toolName: toolCallContext.toolName
                  }
                })
                continue
              }

              if (
                (part.type === 'tool-output-available' || part.type === 'tool-result') &&
                part.preliminary !== true &&
                emitToolCallFinish &&
                typeof part.toolCallId === 'string'
              ) {
                const toolCallContext =
                  (typeof part.toolName === 'string'
                    ? { input: part.input, toolName: part.toolName }
                    : undefined) ?? toolCallContextById.get(part.toolCallId)

                if (!toolCallContext) {
                  continue
                }

                emitToolCallFinish({
                  abortSignal: request.signal,
                  durationMs: 0,
                  experimental_context: undefined,
                  functionId: undefined,
                  metadata: undefined,
                  model: undefined,
                  messages: request.messages,
                  stepNumber: undefined,
                  success: true,
                  output: part.output,
                  toolCall: {
                    type: 'tool-call',
                    dynamic: true,
                    toolCallId: part.toolCallId,
                    toolName: toolCallContext.toolName,
                    input: toolCallContext.input
                  }
                })
                toolCallContextById.delete(part.toolCallId)
                continue
              }

              if (
                (part.type === 'tool-output-error' || part.type === 'tool-error') &&
                emitToolCallFinish &&
                typeof part.toolCallId === 'string'
              ) {
                const toolCallContext =
                  (typeof part.toolName === 'string'
                    ? { input: part.input, toolName: part.toolName }
                    : undefined) ?? toolCallContextById.get(part.toolCallId)

                if (!toolCallContext) {
                  continue
                }

                emitToolCallFinish({
                  abortSignal: request.signal,
                  durationMs: 0,
                  experimental_context: undefined,
                  functionId: undefined,
                  metadata: undefined,
                  model: undefined,
                  messages: request.messages,
                  stepNumber: undefined,
                  success: false,
                  error: part.error ?? part.errorText,
                  toolCall: {
                    type: 'tool-call',
                    dynamic: true,
                    toolCallId: part.toolCallId,
                    toolName: toolCallContext.toolName,
                    input: toolCallContext.input
                  }
                })
                toolCallContextById.delete(part.toolCallId)
              }
            }

            if (request.onFinish && 'usage' in result && 'totalUsage' in result) {
              type AiSdkUsage = { inputTokens?: number; outputTokens?: number }
              const responsePromise =
                'response' in result
                  ? (result.response as PromiseLike<{ messages?: unknown[] }>)
                  : undefined
              const [usage, total, response] = await Promise.all([
                result.usage as PromiseLike<AiSdkUsage>,
                result.totalUsage as PromiseLike<AiSdkUsage>,
                responsePromise
              ])
              // Resolve finishReason separately so it can't block the critical path.
              let finishReason: string | undefined
              try {
                if ('finishReason' in result) {
                  finishReason = await Promise.resolve(result.finishReason as PromiseLike<string>)
                }
              } catch {
                // Provider didn't expose a usable finishReason — not critical.
              }
              if (usage.inputTokens != null && usage.outputTokens != null) {
                const responseMessages = response?.messages
                request.onFinish({
                  promptTokens: usage.inputTokens,
                  completionTokens: usage.outputTokens,
                  totalPromptTokens: total.inputTokens ?? usage.inputTokens,
                  totalCompletionTokens: total.outputTokens ?? usage.outputTokens,
                  ...(finishReason ? { finishReason } : {}),
                  ...(Array.isArray(responseMessages) && responseMessages.length > 0
                    ? { responseMessages }
                    : {})
                })
              }
            }

            return
          }

          for await (const textPart of result.textStream) {
            if (textPart) {
              streamCommitted = true
              yield textPart
            }
          }

          // Stream completed successfully — exit the retry loop.
          return
        } catch (error) {
          if (request.signal.aborted) {
            throw error
          }

          if (shouldLogGatewayDiagnostics(request.settings)) {
            logGatewayDiagnostics('streamReply-error', {
              error: toSerializableError(error),
              model: request.settings.model,
              providerOptions
            })
          } else if (request.settings.provider === 'vertex') {
            console.error('[yachiyo][vertex] stream error', {
              error: error instanceof Error ? error.message : String(error),
              model: request.settings.model
            })
          }

          // Once assistant text or tool activity was forwarded, retrying would
          // duplicate user-visible output or side effects.
          if (streamCommitted || attempt >= RETRY_MAX_ATTEMPTS || !isRetryableModelError(error)) {
            throw error
          }

          console.warn(
            `[yachiyo][stream] attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed, retrying in ${retryDelay}ms:`,
            error instanceof Error ? error.message : error
          )
          request.onRetry?.(attempt, RETRY_MAX_ATTEMPTS, retryDelay, error)

          await sleep(retryDelay, request.signal)
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_DELAY_MS)
        }
      }
    }
  }
}
