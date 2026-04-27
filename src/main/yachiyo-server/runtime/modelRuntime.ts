import { stepCountIs } from 'ai'

import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelMessage, ModelRuntime } from './types.ts'
import {
  type AiSdkRuntimeDependencies,
  type FetchModelsDependencies,
  resolveAiSdkRuntimeDependencies
} from './providers/dependencies.ts'
import { fetchModels as fetchModelsImpl } from './providers/fetchModels.ts'
import { assertConfigured, createLanguageModel } from './providers/languageModel.ts'
import {
  formatErrorForLog,
  logGatewayDiagnostics,
  shouldLogGatewayDiagnostics,
  toSerializableError
} from './providers/gateway.ts'
import { getGeminiMaxOutputTokens } from './providers/google.ts'
import { createProviderOptions, extractThinkingBudget } from './providers/providerOptions.ts'
import type { RuntimeProviderOptions } from './providers/shared.ts'
import { isTransientTransportError, toRunBoundaryError } from './runtimeErrors.ts'
/** Disable AI SDK's built-in retry — we handle retries ourselves. */
const SDK_MAX_RETRIES = 0

export const RETRY_MAX_ATTEMPTS = 10
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000

function readTextDelta(part: { delta?: string; text?: string; textDelta?: string }): string | null {
  return part.delta ?? part.textDelta ?? part.text ?? null
}

/**
 * Ensure every reasoning block in responseMessages has the provider metadata
 * (signature) needed for the Anthropic adapter to round-trip it. Non-Anthropic
 * providers (e.g. Kimi) emit reasoning blocks without Anthropic signatures,
 * causing the adapter to silently drop them on the next request. We patch in a
 * synthetic signature so the content survives across steer/restart legs.
 *
 * We skip injection when the block already has an Anthropic signature in
 * providerOptions or metadata from any non-Anthropic provider (OpenAI, Google,
 * etc.) so we don't pile provider-specific metadata on top of each other.
 *
 * If the signature only lives in providerMetadata (as the AI SDK stores it
 * after an Anthropic response), we copy it into providerOptions because the
 * Anthropic adapter reads from providerOptions when building the prompt.
 */
function patchReasoningSignatures(messages: unknown[]): unknown[] {
  let patched = false
  const result = messages.map((msg) => {
    const m = msg as { role?: string; content?: unknown[] }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return msg

    let contentPatched = false
    const content = m.content.map((part) => {
      const p = part as {
        type?: string
        text?: string
        providerMetadata?: Record<string, unknown>
        providerOptions?: Record<string, unknown>
      }
      if (p.type !== 'reasoning') return part

      const anthropicOptions = p.providerOptions?.anthropic as Record<string, unknown> | undefined
      const anthropicMetadata = p.providerMetadata?.anthropic as Record<string, unknown> | undefined

      // Already has the signature where the adapter looks — nothing to do.
      if (anthropicOptions?.signature) return part

      // Signature only lives in providerMetadata — copy it to providerOptions
      // so the Anthropic adapter can find it on the next request.
      if (anthropicMetadata?.signature) {
        contentPatched = true
        return {
          ...p,
          providerOptions: {
            ...p.providerOptions,
            anthropic: { ...anthropicOptions, signature: anthropicMetadata.signature }
          }
        }
      }

      // Skip injection for any non-Anthropic provider metadata.
      const nonAnthropicEntries = [
        ...Object.entries(p.providerOptions ?? {}).filter(([key]) => key !== 'anthropic'),
        ...Object.entries(p.providerMetadata ?? {}).filter(([key]) => key !== 'anthropic')
      ]
      const hasNonAnthropicMeta = nonAnthropicEntries.some(
        ([, value]) => value != null && typeof value === 'object' && Object.keys(value).length > 0
      )
      if (hasNonAnthropicMeta) return part

      // Bare reasoning block — inject synthetic signature for Anthropic compatibility.
      // The adapter reads `providerOptions`, not `providerMetadata`.
      contentPatched = true
      const syntheticAnthropicMeta = {
        ...(anthropicOptions as Record<string, unknown> | undefined),
        ...(anthropicMetadata as Record<string, unknown> | undefined),
        signature: 'yachiyo-passthrough'
      }
      return {
        ...p,
        providerOptions: {
          ...p.providerOptions,
          anthropic: syntheticAnthropicMeta
        },
        providerMetadata: {
          ...p.providerMetadata,
          anthropic: syntheticAnthropicMeta
        }
      }
    })

    if (!contentPatched) return msg
    patched = true
    return { ...m, content }
  })

  return patched ? result : messages
}

type ResponseMessage = { role?: string; content?: unknown[]; reasoning_content?: string }

/**
 * Extract `reasoning_content` from stored assistant messages in the
 * conversation history. These values pre-seed the fetch wrapper so it
 * can echo them back on the first API request of a new run.
 */
function extractHistoricalReasoningContents(messages: ModelMessage[]): string[] {
  const result: string[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const rc = (msg as ResponseMessage).reasoning_content
      result.push(rc ?? '')
    }
  }
  return result.some((r) => r.length > 0) ? result : []
}

/**
 * Inject `reasoning_content` into assistant messages in responseMessages
 * when the SDK's OpenAI chat model didn't capture it from the SSE stream.
 *
 * Uses the ChatCompletion wire format: `reasoning_content` as a top-level
 * field on the assistant message object (not a content-part type).
 *
 * Each entry in `perStepReasoning` maps 1:1 to the Nth assistant message.
 * Empty entries preserve step alignment without modifying the message.
 * Skips injection when `reasoning_content` already exists.
 */
export function injectStepReasoning(
  responseMessages: unknown[],
  perStepReasoning: string[]
): unknown[] {
  if (perStepReasoning.every((text) => text.length === 0)) return responseMessages

  const msgs = responseMessages as ResponseMessage[]
  const hasExisting = msgs.some(
    (msg) => msg.role === 'assistant' && typeof msg.reasoning_content === 'string'
  )
  if (hasExisting) return responseMessages

  let modified = false
  const result = [...responseMessages]
  let reasoningIdx = 0
  for (let i = 0; i < result.length && reasoningIdx < perStepReasoning.length; i++) {
    const msg = result[i] as ResponseMessage
    if (msg.role === 'assistant') {
      if (perStepReasoning[reasoningIdx]) {
        result[i] = { ...msg, reasoning_content: perStepReasoning[reasoningIdx] }
        modified = true
      }
      reasoningIdx++
    }
  }

  return modified ? result : responseMessages
}

function toToolError(error: unknown, fallbackMessage = 'Tool execution failed'): Error {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return new Error(error)
  }

  return new Error(fallbackMessage)
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

      const preparedMessages = patchReasoningSignatures(
        prepareAiSdkMessages(request.messages) as unknown[]
      ) as ModelMessage[]

      const baseProviderOptions = createProviderOptions(
        request.settings,
        request.providerOptionsMode ?? 'default'
      )
      // Merge prompt cache key into OpenAI provider options when present.
      const providerOptions: RuntimeProviderOptions =
        request.promptCacheKey && 'openai' in baseProviderOptions
          ? (() => {
              const openai = (baseProviderOptions as { openai: Record<string, unknown> }).openai
              return {
                ...baseProviderOptions,
                openai: { ...openai, promptCacheKey: request.promptCacheKey }
              } as typeof baseProviderOptions
            })()
          : baseProviderOptions

      const purpose = request.purpose ?? 'unspecified'
      const provider = request.settings.provider
      const model = request.settings.model
      const llmTag = `[yachiyo][llm][${purpose}]`
      const startedAt = Date.now()
      console.info(
        `${llmTag} start provider=${provider} model=${model} messages=${preparedMessages.length} mode=${request.providerOptionsMode ?? 'default'} tools=${request.tools ? Object.keys(request.tools).length : 0} maxToolSteps=${request.maxToolSteps ?? 'default'}${request.promptCacheKey ? ` promptCacheKey=${request.promptCacheKey}` : ''}`
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
      let totalYieldedChars = 0

      let stepReasoningChunks: string[][] = [[]]
      const interceptReasoningDelta = request.onReasoningDelta
        ? (delta: string) => {
            stepReasoningChunks[stepReasoningChunks.length - 1].push(delta)
            request.onReasoningDelta!(delta)
          }
        : undefined

      for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
        stepReasoningChunks = [[]]
        const attemptStartedAt = Date.now()
        console.info(
          `${llmTag} attempt ${attempt}/${RETRY_MAX_ATTEMPTS} provider=${provider} model=${model}`
        )
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
              request.providerOptionsMode,
              {
                onReasoningDelta: interceptReasoningDelta,
                ...(provider === 'openai'
                  ? {
                      historicalReasoningContents:
                        extractHistoricalReasoningContents(preparedMessages)
                    }
                  : {})
              }
            ),
            providerOptions,
            ...(request.max_token != null
              ? {
                  maxOutputTokens:
                    request.settings.provider === 'gemini' || request.settings.provider === 'vertex'
                      ? getGeminiMaxOutputTokens(request.settings.model)
                      : request.max_token +
                        extractThinkingBudget(providerOptions, request.settings) * 2
                }
              : {}),
            ...(request.tools
              ? {
                  tools: request.tools,
                  ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
                  stopWhen: request.stopWhen ?? stepCountIs(request.maxToolSteps ?? 100)
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
              id?: string
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
              usage?: { inputTokens?: number; outputTokens?: number }
              totalUsage?: { inputTokens?: number; outputTokens?: number }
            }>) {
              if (part.type === 'finish-step' || part.type === 'finish') {
                console.log(
                  `[yachiyo][stream] ${part.type}: finishReason=${part.finishReason ?? 'unknown'}, step=${part.stepNumber ?? '?'}, isContinued=${part.isContinued ?? false}`
                )
                if (request.onStepUsage && part.usage) {
                  const prompt = part.usage.inputTokens ?? 0
                  const completion = part.usage.outputTokens ?? 0
                  if (prompt > 0 || completion > 0) {
                    request.onStepUsage({ promptTokens: prompt, completionTokens: completion })
                  }
                }
                if (part.type === 'finish-step') {
                  stepReasoningChunks.push([])
                }
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
                interceptReasoningDelta?.(readTextDelta(part) as string)
                continue
              }

              if (part.type === 'text-delta' && readTextDelta(part)) {
                streamCommitted = true
                const delta = readTextDelta(part) as string
                totalYieldedChars += delta.length
                yield delta
                continue
              }

              if (
                part.type === 'tool-input-start' &&
                typeof part.id === 'string' &&
                typeof part.toolName === 'string'
              ) {
                streamCommitted = true
                request.onToolCallPreparing?.({
                  toolCallId: part.id,
                  toolName: part.toolName
                })
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
                const toolCallContext =
                  (typeof part.toolName === 'string'
                    ? { input: part.input, toolName: part.toolName }
                    : undefined) ?? toolCallContextById.get(part.toolCallId)

                if (!toolCallContext) {
                  continue
                }

                const toolCall = {
                  input: toolCallContext.input,
                  toolCallId: part.toolCallId,
                  toolName: toolCallContext.toolName
                }
                const toolError = toToolError(
                  part.error ?? part.errorText,
                  'Tool input validation failed'
                )

                // Preserve context so a subsequent tool-output-error can resolve
                // the tool call and route it to onToolCallFinish.
                toolCallContextById.set(part.toolCallId, toolCallContext)

                if (request.onToolCallError?.({ error: toolError, toolCall }) === 'abort') {
                  streamCommitted = true
                  toolCallContextById.delete(part.toolCallId)
                  throw toolError
                }
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
                (emitToolCallFinish || request.onToolCallError) &&
                typeof part.toolCallId === 'string'
              ) {
                const toolCallContext =
                  (typeof part.toolName === 'string'
                    ? { input: part.input, toolName: part.toolName }
                    : undefined) ?? toolCallContextById.get(part.toolCallId)

                if (!toolCallContext) {
                  continue
                }

                const toolCall = {
                  input: toolCallContext.input,
                  toolCallId: part.toolCallId,
                  toolName: toolCallContext.toolName
                }
                const toolError = toToolError(part.error ?? part.errorText)

                if (emitToolCallFinish) {
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
                    error: toolError,
                    toolCall: {
                      type: 'tool-call',
                      dynamic: true,
                      ...toolCall
                    }
                  })
                }
                toolCallContextById.delete(part.toolCallId)

                if (request.onToolCallError?.({ error: toolError, toolCall }) === 'abort') {
                  throw toolError
                }
              }
            }

            if (request.onFinish && 'usage' in result && 'totalUsage' in result) {
              type AiSdkUsage = {
                inputTokens?: number
                outputTokens?: number
                inputTokenDetails?: {
                  cacheReadTokens?: number
                  cacheWriteTokens?: number
                }
              }
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
              const cacheRead =
                total.inputTokenDetails?.cacheReadTokens ?? usage.inputTokenDetails?.cacheReadTokens
              const cacheWrite =
                total.inputTokenDetails?.cacheWriteTokens ??
                usage.inputTokenDetails?.cacheWriteTokens
              console.info(
                `${llmTag} usage provider=${provider} model=${model} promptTokens=${usage.inputTokens ?? '?'} completionTokens=${usage.outputTokens ?? '?'} totalPrompt=${total.inputTokens ?? '?'} totalCompletion=${total.outputTokens ?? '?'} cacheRead=${cacheRead ?? '-'} cacheWrite=${cacheWrite ?? '-'} finishReason=${finishReason ?? 'unknown'}`
              )
              if (cacheRead === 0 || cacheRead == null) {
                console.debug(
                  `${llmTag} cache-diag inputTokenDetails=${JSON.stringify(usage.inputTokenDetails ?? null)}`
                )
              }
              if (usage.inputTokens != null && usage.outputTokens != null) {
                const responseMessages = response?.messages
                const isOpenAiChatProvider = provider === 'openai'
                const perStepReasoning = isOpenAiChatProvider
                  ? stepReasoningChunks.map((chunks) => chunks.join(''))
                  : []
                const enrichedResponseMessages =
                  Array.isArray(responseMessages) && responseMessages.length > 0
                    ? patchReasoningSignatures(
                        injectStepReasoning(responseMessages, perStepReasoning) as unknown[]
                      )
                    : undefined
                request.onFinish({
                  promptTokens: usage.inputTokens,
                  completionTokens: usage.outputTokens,
                  totalPromptTokens: total.inputTokens ?? usage.inputTokens,
                  totalCompletionTokens: total.outputTokens ?? usage.outputTokens,
                  ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
                  ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
                  ...(finishReason ? { finishReason } : {}),
                  ...(enrichedResponseMessages
                    ? { responseMessages: enrichedResponseMessages }
                    : {})
                })
              }
            }

            console.info(
              `${llmTag} done provider=${provider} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} totalDurationMs=${Date.now() - startedAt} chars=${totalYieldedChars}`
            )
            return
          }

          for await (const textPart of result.textStream) {
            if (textPart) {
              streamCommitted = true
              totalYieldedChars += textPart.length
              yield textPart
            }
          }

          // Stream completed successfully — exit the retry loop.
          console.info(
            `${llmTag} done provider=${provider} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} totalDurationMs=${Date.now() - startedAt} chars=${totalYieldedChars}`
          )
          return
        } catch (error) {
          if (request.signal.aborted) {
            console.info(
              `${llmTag} aborted provider=${provider} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt}`
            )
            throw error
          }

          const errorLogMessage = formatErrorForLog(error)
          console.error(
            `${llmTag} error provider=${provider} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} committed=${streamCommitted}: ${errorLogMessage}`
          )

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
          if (
            streamCommitted ||
            attempt >= RETRY_MAX_ATTEMPTS ||
            !isTransientTransportError(error)
          ) {
            console.error(
              `${llmTag} giving up provider=${provider} model=${model} attempt=${attempt} committed=${streamCommitted} totalDurationMs=${Date.now() - startedAt}`
            )
            // Wrap transient transport errors into the typed retry contract so
            // the outer run-execution recovery path can decide via instanceof,
            // not via a second round of shape matching. Non-transient errors
            // (auth, validation, bugs) pass through unchanged.
            throw toRunBoundaryError(error)
          }

          console.warn(
            `${llmTag} retrying attempt=${attempt}/${RETRY_MAX_ATTEMPTS} delayMs=${retryDelay}: ${errorLogMessage}`
          )
          request.onRetry?.(attempt, RETRY_MAX_ATTEMPTS, retryDelay, error)

          await resolvedDependencies.sleepImpl(retryDelay, request.signal)
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_DELAY_MS)
        }
      }
    }
  }
}
