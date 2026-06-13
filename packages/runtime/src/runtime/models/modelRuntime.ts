import { createHash } from 'node:crypto'

import { stepCountIs } from 'ai'

import { applyStripCompact } from '../context/contextStripCompact.ts'
import { prepareAiSdkMessages } from '../messages/messagePrepare.ts'
import type { ModelMessage, ModelRuntime } from './types.ts'
import {
  type AiSdkRuntimeDependencies,
  type FetchModelsDependencies,
  resolveAiSdkRuntimeDependencies
} from '../providers/dependencies.ts'
import { fetchModels as fetchModelsImpl } from '../providers/fetchModels.ts'
import { assertConfigured, createLanguageModel } from '../providers/languageModel.ts'
import { resolveReasoningSelection } from '@yachiyo/shared/reasoningEffort'
import {
  formatErrorForLog,
  logGatewayDiagnostics,
  shouldLogGatewayDiagnostics,
  toSerializableError
} from '../providers/gateway.ts'
import { getGeminiMaxOutputTokens } from '../providers/google.ts'
import { createProviderOptions, extractThinkingBudget } from '../providers/providerOptions.ts'
import { supportsOpenAIReasoningEffort } from '../providers/openai.ts'
import type { RuntimeProviderOptions } from '../providers/shared.ts'
import {
  isContextWindowExceededError,
  isTransientTransportError,
  toRunBoundaryError
} from './runtimeErrors.ts'
/** Disable AI SDK's built-in retry — we handle retries ourselves. */
const SDK_MAX_RETRIES = 0

export const RETRY_MAX_ATTEMPTS = 10
const CONTEXT_STRIP_COMPACT_MAX_RETRIES = 5
const FORCED_STRIP_COMPACT_TOKEN_THRESHOLD = 1
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_TOOL_STEPS = 999

function readTextDelta(part: { delta?: string; text?: string; textDelta?: string }): string | null {
  return part.delta ?? part.textDelta ?? part.text ?? null
}

type AiSdkStreamUsage = {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: {
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

interface PendingStepFinish {
  finishReason?: string
  stepNumber: number
  usage?: AiSdkStreamUsage
}

interface StepRequestPrefixState {
  initialBody?: string
  previousBody?: string
}

function formatTokenCount(value: number | undefined): string {
  return value == null ? '-' : String(value)
}

function formatDiagnosticValue(value: string | number | undefined): string {
  return value == null ? '-' : String(value)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function readRequestBodyText(request: { body?: unknown } | undefined): string | undefined {
  const body = request?.body
  if (typeof body === 'string') {
    return body
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body)
  }
  if (body && typeof body === 'object') {
    try {
      return JSON.stringify(body)
    } catch {
      return undefined
    }
  }
  return undefined
}

function countCommonPrefixChars(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index++
  }
  return index
}

function readRequestBodyStats(body: string): {
  inputItems?: number
  inputHash?: string
  instructionsHash?: string
  promptCacheKey?: string
} {
  try {
    const parsed = JSON.parse(body) as {
      input?: unknown
      instructions?: unknown
      prompt_cache_key?: unknown
    }
    const input = parsed.input
    const inputJson = input === undefined ? undefined : JSON.stringify(input)
    return {
      ...(Array.isArray(input) ? { inputItems: input.length } : {}),
      ...(inputJson ? { inputHash: hashText(inputJson) } : {}),
      ...(typeof parsed.instructions === 'string'
        ? { instructionsHash: hashText(parsed.instructions) }
        : {}),
      ...(typeof parsed.prompt_cache_key === 'string'
        ? { promptCacheKey: parsed.prompt_cache_key }
        : {})
    }
  } catch {
    return {}
  }
}

function logStepRequestPrefix(
  llmTag: string,
  input: { body: string; state: StepRequestPrefixState; stepNumber: number }
): void {
  const stats = readRequestBodyStats(input.body)
  const commonPrefixInitialChars =
    input.state.initialBody === undefined
      ? undefined
      : countCommonPrefixChars(input.state.initialBody, input.body)
  const commonPrefixPreviousChars =
    input.state.previousBody === undefined
      ? undefined
      : countCommonPrefixChars(input.state.previousBody, input.body)

  console.info(
    `${llmTag} request step ${input.stepNumber} bodyChars=${input.body.length} bodyHash=${hashText(input.body)} commonPrefixInitialChars=${formatDiagnosticValue(commonPrefixInitialChars)} commonPrefixPreviousChars=${formatDiagnosticValue(commonPrefixPreviousChars)} inputItems=${formatDiagnosticValue(stats.inputItems)} inputHash=${formatDiagnosticValue(stats.inputHash)} instructionsHash=${formatDiagnosticValue(stats.instructionsHash)} promptCacheKey=${formatDiagnosticValue(stats.promptCacheKey)}`
  )

  input.state.initialBody ??= input.body
  input.state.previousBody = input.body
}

function logStepFinish(llmTag: string, step: PendingStepFinish, continued: boolean): void {
  console.info(
    `${llmTag} step ${step.stepNumber} finishReason=${step.finishReason ?? 'unknown'} continued=${continued} promptTokens=${formatTokenCount(step.usage?.inputTokens)} completionTokens=${formatTokenCount(step.usage?.outputTokens)} cacheRead=${formatTokenCount(step.usage?.inputTokenDetails?.cacheReadTokens)} cacheWrite=${formatTokenCount(step.usage?.inputTokenDetails?.cacheWriteTokens)}`
  )
}

function logStreamFinish(
  llmTag: string,
  input: { finishReason?: string; steps: number; totalUsage?: AiSdkStreamUsage }
): void {
  console.info(
    `${llmTag} finish finishReason=${input.finishReason ?? 'unknown'} steps=${input.steps} totalPromptTokens=${formatTokenCount(input.totalUsage?.inputTokens)} totalCompletionTokens=${formatTokenCount(input.totalUsage?.outputTokens)} cacheRead=${formatTokenCount(input.totalUsage?.inputTokenDetails?.cacheReadTokens)} cacheWrite=${formatTokenCount(input.totalUsage?.inputTokenDetails?.cacheWriteTokens)}`
  )
}

function readStreamErrorMessage(value: unknown): string | null {
  if (value == null) {
    return null
  }

  if (value instanceof Error) {
    const trimmed = value.message.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (typeof value !== 'object') {
    return String(value)
  }

  const record = value as Record<string, unknown>
  const message = readStreamErrorMessage(record.message)
  if (message) {
    return message
  }

  const nestedError = readStreamErrorMessage(record.error)
  if (nestedError) {
    return nestedError
  }

  const code = readStreamErrorMessage(record.code)
  if (code) {
    return code
  }

  try {
    const serialized = JSON.stringify(value)
    return serialized && serialized !== '{}' ? serialized : null
  } catch {
    return String(value)
  }
}

function toStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(readStreamErrorMessage(error) ?? 'Unknown stream error', { cause: error })
}

function measurePromptPayload(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length
}

/**
 * Keep provider-native reasoning metadata in the field read by the target
 * adapter. Real Anthropic signatures are copied from providerMetadata to
 * providerOptions for replay.
 */
export function patchReasoningSignatures(
  messages: unknown[],
  providerKind?: string,
  model?: string
): unknown[] {
  if (providerKind === 'anthropic') {
    return patchAnthropicReasoningSignatures(messages)
  }

  const usesResponsesApi =
    providerKind === 'openai-responses' ||
    providerKind === 'openai-codex' ||
    (providerKind === 'openai' && model != null && supportsOpenAIReasoningEffort(model))

  if (usesResponsesApi) {
    return sanitizeForOpenaiResponses(messages)
  }

  return messages
}

function patchAnthropicReasoningSignatures(messages: unknown[]): unknown[] {
  let patched = false
  const result = messages.map((msg) => {
    const m = msg as { role?: string; content?: unknown[] }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return msg

    let contentPatched = false
    const content = m.content.map((part) => {
      const p = part as {
        type?: string
        providerOptions?: Record<string, unknown>
        providerMetadata?: Record<string, unknown>
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

      return part
    })

    if (!contentPatched) return msg
    patched = true
    return { ...m, content }
  })

  return patched ? result : messages
}

function sanitizeForOpenaiResponses(messages: unknown[]): unknown[] {
  let patched = false
  const result = messages.map((msg) => {
    const m = msg as { role?: string; content?: unknown[] }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return msg

    let contentPatched = false
    const content: unknown[] = []
    for (const part of m.content) {
      const p = part as {
        type?: string
        providerOptions?: Record<string, unknown>
        providerMetadata?: Record<string, unknown>
      }
      if (p.type !== 'reasoning') {
        content.push(part)
        continue
      }

      const openaiOptions = p.providerOptions?.openai as Record<string, unknown> | undefined
      const openaiMetadata = p.providerMetadata?.openai as Record<string, unknown> | undefined

      // The AI SDK stores OpenAI Responses reasoning metadata in providerMetadata,
      // but the OpenAI converter reads from providerOptions. Check both.
      const hasOpenAiRoundTripData =
        openaiOptions?.itemId != null ||
        openaiOptions?.reasoningEncryptedContent != null ||
        openaiMetadata?.itemId != null ||
        openaiMetadata?.reasoningEncryptedContent != null

      // Keep only OpenAI-native reasoning that can be round-tripped.
      // Drop everything else to avoid "Non-OpenAI reasoning" warnings.
      if (hasOpenAiRoundTripData) {
        if (openaiMetadata != null) {
          contentPatched = true
          content.push({
            ...p,
            providerOptions: {
              ...p.providerOptions,
              openai: { ...openaiMetadata, ...openaiOptions }
            }
          })
          continue
        }

        content.push(part)
        continue
      }

      contentPatched = true
    }

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
  provider: import('@yachiyo/shared/protocol').ProviderConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  dependencies: FetchModelsDependencies = {}
): Promise<string[]> {
  return fetchModelsImpl(provider, fetchImpl, dependencies)
}

export function createAiSdkModelRuntime(dependencies: AiSdkRuntimeDependencies = {}): ModelRuntime {
  const resolvedDependencies = resolveAiSdkRuntimeDependencies(dependencies)

  return {
    async *streamReply(request) {
      let settings = request.settings

      // Resolve Codex OAuth token if using openai-codex provider
      if (settings.provider === 'openai-codex' && settings.codexSessionPath?.trim()) {
        const { readCodexSessionAuth } = await import('../providers/codexSessionAuth.ts')
        const { accessToken, accountId } = await readCodexSessionAuth(settings.codexSessionPath)
        settings = {
          ...settings,
          apiKey: accessToken,
          ...(accountId ? { codexAccountId: accountId } : {})
        }
      }

      assertConfigured(settings)
      const reasoningEffort = resolveReasoningSelection({
        provider: settings,
        model: settings.model,
        requested: request.reasoningEffort
      })
      settings = {
        ...settings,
        reasoningEffort,
        thinkingEnabled: reasoningEffort !== 'off'
      }

      const provider = settings.provider

      let preparedMessages = patchReasoningSignatures(
        prepareAiSdkMessages(request.messages) as unknown[],
        provider,
        settings.model
      ) as ModelMessage[]

      const baseProviderOptions = createProviderOptions(
        settings,
        request.providerOptionsMode ?? 'default',
        reasoningEffort
      )
      // Merge prompt cache key into OpenAI provider options when present.
      let providerOptions: RuntimeProviderOptions =
        request.promptCacheKey && 'openai' in baseProviderOptions
          ? (() => {
              const openai = (baseProviderOptions as { openai: Record<string, unknown> }).openai
              return {
                ...baseProviderOptions,
                openai: { ...openai, promptCacheKey: request.promptCacheKey }
              } as typeof baseProviderOptions
            })()
          : baseProviderOptions

      // Codex backend requires `instructions` field for system prompt
      if (settings.provider === 'openai-codex') {
        const { prepareCodexMessages } = await import('../providers/codexOpenai.ts')
        const prepared = prepareCodexMessages(preparedMessages, providerOptions)
        preparedMessages = prepared.messages
        providerOptions = prepared.options
      }

      const purpose = request.purpose ?? 'unspecified'
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
      let contextStripCompactRetries = 0

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
        let nextStepNumber = 0
        let pendingStepFinish: PendingStepFinish | undefined
        const requestPrefixState: StepRequestPrefixState = {}

        const flushPendingStepFinish = (continued: boolean): void => {
          if (!pendingStepFinish) return
          logStepFinish(llmTag, pendingStepFinish, continued)
          pendingStepFinish = undefined
        }

        try {
          const result = resolvedDependencies.streamTextImpl({
            abortSignal: request.signal,
            maxRetries: SDK_MAX_RETRIES,
            messages: preparedMessages,
            model: createLanguageModel(
              settings,
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
                      : request.max_token + extractThinkingBudget(providerOptions, settings) * 2
                }
              : {}),
            ...(request.tools
              ? {
                  tools: request.tools,
                  ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
                  stopWhen:
                    request.stopWhen ?? stepCountIs(request.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS)
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
              request?: { body?: unknown }
              stepNumber?: number
              text?: string
              toolCallId?: string
              toolName?: string
              type: string
              usage?: AiSdkStreamUsage
              totalUsage?: AiSdkStreamUsage
            }>) {
              if (pendingStepFinish && part.type !== 'finish') {
                flushPendingStepFinish(true)
              }

              if (part.type === 'start-step') {
                const requestBody = readRequestBodyText(part.request)
                if (request.promptCacheKey && requestBody !== undefined) {
                  logStepRequestPrefix(llmTag, {
                    body: requestBody,
                    state: requestPrefixState,
                    stepNumber: nextStepNumber
                  })
                }
              }

              if (part.type === 'finish-step') {
                pendingStepFinish = {
                  finishReason: part.finishReason,
                  stepNumber: nextStepNumber,
                  usage: part.usage
                }
                nextStepNumber++
                if (request.onStepUsage && part.usage) {
                  const prompt = part.usage.inputTokens ?? 0
                  const completion = part.usage.outputTokens ?? 0
                  if (prompt > 0 || completion > 0) {
                    request.onStepUsage({ promptTokens: prompt, completionTokens: completion })
                  }
                }
                stepReasoningChunks.push([])
              }

              if (part.type === 'finish') {
                flushPendingStepFinish(false)
                logStreamFinish(llmTag, {
                  finishReason: part.finishReason,
                  steps: nextStepNumber,
                  totalUsage: part.totalUsage
                })
              }

              if (part.type === 'error') {
                throw toStreamError(part.error)
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
            flushPendingStepFinish(false)

            if (request.onFinish && 'usage' in result && 'totalUsage' in result) {
              const responsePromise =
                'response' in result
                  ? (result.response as PromiseLike<{ messages?: unknown[] }>)
                  : undefined
              const [usage, total, response] = await Promise.all([
                result.usage as PromiseLike<AiSdkStreamUsage>,
                result.totalUsage as PromiseLike<AiSdkStreamUsage>,
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
                `${llmTag} usage provider=${provider} model=${model} finalPromptTokens=${usage.inputTokens ?? '?'} finalCompletionTokens=${usage.outputTokens ?? '?'} totalPromptTokens=${total.inputTokens ?? '?'} totalCompletionTokens=${total.outputTokens ?? '?'} cacheRead=${cacheRead ?? '-'} cacheWrite=${cacheWrite ?? '-'} finishReason=${finishReason ?? 'unknown'}`
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
                        injectStepReasoning(responseMessages, perStepReasoning) as unknown[],
                        provider,
                        model
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

          // Codex OAuth: force-refresh token on 401 and retry immediately.
          if (
            !streamCommitted &&
            settings.provider === 'openai-codex' &&
            settings.codexSessionPath?.trim() &&
            (error as { statusCode?: number }).statusCode === 401 &&
            attempt < RETRY_MAX_ATTEMPTS
          ) {
            try {
              const { readCodexSessionAuth } = await import('../providers/codexSessionAuth.ts')
              const { accessToken, accountId } = await readCodexSessionAuth(
                settings.codexSessionPath,
                true
              )
              settings = {
                ...settings,
                apiKey: accessToken,
                ...(accountId ? { codexAccountId: accountId } : {})
              }
              console.warn(`${llmTag} refreshed Codex token after 401, retrying`)
              continue
            } catch (refreshError) {
              const refreshMsg = formatErrorForLog(refreshError)
              console.error(`${llmTag} Codex token refresh after 401 failed: ${refreshMsg}`)
            }
          }

          if (
            !streamCommitted &&
            isContextWindowExceededError(error) &&
            contextStripCompactRetries < CONTEXT_STRIP_COMPACT_MAX_RETRIES &&
            attempt < RETRY_MAX_ATTEMPTS
          ) {
            const compactedMessages = applyStripCompact(
              preparedMessages,
              request.tools ? Object.keys(request.tools).length : 0,
              undefined,
              FORCED_STRIP_COMPACT_TOKEN_THRESHOLD
            )
            if (measurePromptPayload(compactedMessages) < measurePromptPayload(preparedMessages)) {
              contextStripCompactRetries++
              preparedMessages = compactedMessages
              console.warn(
                `${llmTag} retrying with context compaction after context-window error ` +
                  `attempt=${contextStripCompactRetries}/${CONTEXT_STRIP_COMPACT_MAX_RETRIES}: ${errorLogMessage}`
              )
              request.onRetry?.(
                contextStripCompactRetries,
                CONTEXT_STRIP_COMPACT_MAX_RETRIES,
                0,
                error
              )
              continue
            }
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
