/**
 * Fetch wrapper that injects provider-specific "thinking" parameters into
 * OpenAI-compatible `/v1/chat/completions` request bodies, and extracts
 * `reasoning_content` from the streaming response so the runtime can
 * surface it as thinking blocks.
 *
 * Each compatible host has its own convention for enabling reasoning.
 * This module centralises that knowledge so the rest of the runtime stays
 * provider-agnostic.
 */

import type { ProviderSettings, ReasoningEffortLevel } from '../../../../shared/yachiyo/protocol'
import {
  KIMI_THINKING_BUDGET_BY_EFFORT,
  OPENAI_COMPAT_THINKING_BUDGET_BY_EFFORT
} from './shared.ts'

// ---------------------------------------------------------------------------
// Host → body-param mapping
// ---------------------------------------------------------------------------

interface ThinkingBodyParams {
  [key: string]: unknown
}

type ThinkingParamResolver = (
  model: string,
  effort: ReasoningEffortLevel
) => ThinkingBodyParams | undefined

/**
 * DeepSeek: nested `thinking` object with type `enabled`.
 * Supported on the deepseek-reasoner, R1, V3, and V4 model families.
 */
function deepseekParams(model: string): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (m.includes('reasoner') || m.includes('r1') || m.includes('v3') || m.includes('v4')) {
    return { thinking: { type: 'enabled' } }
  }
  return undefined
}

/**
 * DashScope (Aliyun Bailian): `enable_thinking` + optional `thinking_budget`.
 * Hosts models from multiple vendors under one endpoint:
 * - Qwen3 / QwQ: supported
 * - GLM (Zhipu): supported — same params as Qwen
 * - MiniMax: thinking is always-on, no params needed (return undefined)
 */
function dashScopeParams(
  model: string,
  effort: ReasoningEffortLevel
): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (m.includes('qwq') || m.includes('qwen3') || m.includes('glm')) {
    return {
      enable_thinking: true,
      thinking_budget: OPENAI_COMPAT_THINKING_BUDGET_BY_EFFORT[effort]
    }
  }
  // MiniMax on DashScope: thinking is always-on, no injection needed
  return undefined
}

/**
 * Zhipu GLM (own endpoint): same `enable_thinking` + `thinking_budget` as DashScope.
 */
function zhipuParams(model: string, effort: ReasoningEffortLevel): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (m.includes('glm')) {
    return {
      enable_thinking: true,
      thinking_budget: OPENAI_COMPAT_THINKING_BUDGET_BY_EFFORT[effort]
    }
  }
  return undefined
}

/**
 * MiniMax (own endpoint): thinking is always-on for reasoning models.
 * No extra params needed.
 */
function minimaxParams(model: string): ThinkingBodyParams | undefined {
  void model
  return undefined
}

/**
 * Kimi / Moonshot: nested `thinking` object with type + budget_tokens.
 * Only kimi-k2 series supports the thinking field.
 */
function kimiParams(model: string, effort: ReasoningEffortLevel): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (m.includes('kimi-k2') || m.includes('k2')) {
    return { thinking: { type: 'enabled', budget_tokens: KIMI_THINKING_BUDGET_BY_EFFORT[effort] } }
  }
  return undefined
}

/**
 * Kimi disable override: kimi-k2 has thinking on by default and requires
 * an explicit `thinking: {type: "disabled"}` to turn it off.
 */
function kimiDisableParams(model: string): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (m.includes('kimi-k2') || m.includes('k2')) {
    return { thinking: { type: 'disabled' } }
  }
  return undefined
}

/**
 * OpenRouter: standardised `reasoning` object.
 */
function openRouterParams(
  model: string,
  effort: ReasoningEffortLevel
): ThinkingBodyParams | undefined {
  void model
  return { reasoning: { effort } }
}

/**
 * OpenCode Go: multi-provider endpoint that hosts models from various vendors.
 * Dispatches thinking params by model family.
 */
function opencodeParams(
  model: string,
  effort: ReasoningEffortLevel
): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (m.includes('glm')) {
    return {
      enable_thinking: true,
      thinking_budget: OPENAI_COMPAT_THINKING_BUDGET_BY_EFFORT[effort]
    }
  }
  if (m.includes('kimi-k2') || m.includes('k2')) {
    return { thinking: { type: 'enabled', budget_tokens: KIMI_THINKING_BUDGET_BY_EFFORT[effort] } }
  }
  if (m.includes('deepseek')) {
    return { thinking: { type: 'enabled' } }
  }
  return undefined
}

/**
 * SiliconFlow: pass-through — mirrors upstream model conventions.
 * DeepSeek-family → `thinking: {type: 'enabled'}`, Qwen-family → `enable_thinking`.
 */
function siliconFlowParams(
  model: string,
  effort: ReasoningEffortLevel
): ThinkingBodyParams | undefined {
  const m = model.toLowerCase()
  if (
    m.includes('deepseek') &&
    (m.includes('r1') || m.includes('reasoner') || m.includes('v3') || m.includes('v4'))
  ) {
    return { thinking: { type: 'enabled' } }
  }
  if (m.includes('qwq') || m.includes('qwen3')) {
    return {
      enable_thinking: true,
      thinking_budget: OPENAI_COMPAT_THINKING_BUDGET_BY_EFFORT[effort]
    }
  }
  return undefined
}

/**
 * Registry: host pattern → resolver.
 * Checked in order; first match wins.
 */
interface HostResolverEntry {
  host: string
  resolve: ThinkingParamResolver
  /** Optional resolver for explicit disable params (e.g. Kimi default-on models). */
  resolveDisable?: ThinkingParamResolver
}

const HOST_RESOLVERS: ReadonlyArray<HostResolverEntry> = [
  { host: 'api.deepseek.com', resolve: deepseekParams },
  { host: 'dashscope.aliyuncs.com', resolve: dashScopeParams },
  { host: 'open.bigmodel.cn', resolve: zhipuParams },
  { host: 'api.minimaxi.com', resolve: minimaxParams },
  { host: 'api.moonshot.cn', resolve: kimiParams, resolveDisable: kimiDisableParams },
  { host: 'api.siliconflow.cn', resolve: siliconFlowParams },
  { host: 'openrouter.ai', resolve: openRouterParams },
  { host: 'opencode.ai', resolve: opencodeParams }
]

function matchEntry(baseUrl: string): HostResolverEntry | undefined {
  let host: string
  try {
    host = new URL(baseUrl).host
  } catch {
    return undefined
  }
  for (const entry of HOST_RESOLVERS) {
    if (host === entry.host || host.endsWith(`.${entry.host}`)) {
      return entry
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Request-body reasoning_content injection
// ---------------------------------------------------------------------------

/**
 * Inject `reasoning_content` back into ALL outgoing assistant messages.
 * The Nth collected reasoning string is mapped to the Nth assistant message;
 * assistant messages beyond the collected range get an empty string.
 * DeepSeek requires the field to be present on every assistant message
 * when thinking mode is enabled, even if the value is empty.
 */
function injectReasoningContentIntoMessages(
  messages: Array<Record<string, unknown>>,
  reasoningContents: string[]
): void {
  let idx = 0
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      msg.reasoning_content = idx < reasoningContents.length ? reasoningContents[idx] : ''
      idx++
    }
  }
}

// ---------------------------------------------------------------------------
// SSE response stream transform — reasoning_content extraction
// ---------------------------------------------------------------------------

/**
 * Transform an SSE response body to extract `reasoning_content` from
 * streaming deltas and deliver it via the `onReasoning` callback.
 *
 * The `@ai-sdk/openai` chat model only parses `delta.content` and ignores
 * `delta.reasoning_content`. This transform intercepts the raw SSE stream
 * and extracts thinking content before the SDK's parser strips it.
 */
function createReasoningExtractStream(
  body: ReadableStream<Uint8Array>,
  onReasoning: (delta: string) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            // Flush any remaining buffer
            if (buffer.length > 0) {
              controller.enqueue(encoder.encode(buffer))
            }
            controller.close()
            break
          }

          buffer += decoder.decode(value, { stream: true })

          // Process complete SSE lines
          const lines = buffer.split('\n')
          // Keep the last (possibly incomplete) line in the buffer
          buffer = lines.pop() ?? ''

          const outputLines: string[] = []

          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6)) as {
                  choices?: Array<{
                    delta?: {
                      reasoning_content?: string | null
                      reasoning?: string | null
                    }
                  }>
                }
                const delta = data.choices?.[0]?.delta
                const reasoningText = delta?.reasoning_content ?? delta?.reasoning
                if (reasoningText) {
                  onReasoning(reasoningText)
                }
              } catch {
                // Not valid JSON — pass through
              }
            }
            outputLines.push(line)
          }

          // Re-join and forward all lines (including the original reasoning_content
          // data — the SDK will ignore that field anyway)
          controller.enqueue(encoder.encode(outputLines.join('\n') + '\n'))
        }
      } catch (error) {
        controller.error(error)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the provider base URL points to a known
 * OpenAI-compatible host that supports thinking params on the
 * chat completions endpoint.
 */
export function isOpenAiCompatibleThinkingHost(baseUrl: string): boolean {
  return matchEntry(baseUrl) !== undefined
}

/**
 * Whether the given base URL points to a host where the model's thinking
 * content arrives as `reasoning_content` in the SSE stream (rather than
 * through the SDK's native reasoning events).
 */
export function needsReasoningExtraction(baseUrl: string): boolean {
  return matchEntry(baseUrl) !== undefined
}

export interface ThinkingFetchOptions {
  /** Callback invoked with each reasoning delta extracted from the SSE stream. */
  onReasoningDelta?: (delta: string) => void
  /** Pre-seeded reasoning_content from stored conversation history (one per historical assistant message). */
  historicalReasoningContents?: string[]
}

/**
 * Create a fetch wrapper that:
 * 1. Injects thinking params into the request body
 * 2. Extracts `reasoning_content` from the SSE response stream via callback
 *
 * Returns `undefined` when the host is not recognised or thinking is disabled,
 * so callers can fall through to the default fetch.
 */
export function createThinkingFetch(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary',
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  options: ThinkingFetchOptions = {}
): typeof globalThis.fetch | undefined {
  const tag = '[yachiyo][openai-compat-thinking]'
  const thinkingOff =
    settings.thinkingEnabled === false || settings.reasoningEffort === 'off' || mode !== 'default'
  const effort =
    settings.reasoningEffort && settings.reasoningEffort !== 'off'
      ? settings.reasoningEffort
      : 'medium'

  const entry = matchEntry(settings.baseUrl)
  if (!entry) {
    console.info(`${tag} skip: no resolver for baseUrl=${settings.baseUrl}`)
    return undefined
  }

  // When thinking is explicitly disabled, some providers need an override
  // param to turn off default-on thinking (e.g. Kimi k2).
  if (thinkingOff) {
    const disableParams = entry.resolveDisable?.(settings.model, effort)
    if (!disableParams) {
      console.info(
        `${tag} skip: thinking off, no disable override needed for model=${settings.model}`
      )
      return undefined
    }
    console.info(
      `${tag} disable: model=${settings.model} injecting=${JSON.stringify(disableParams)}`
    )
    return async (input, init) => {
      if (init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>
          Object.assign(body, disableParams)
          init = { ...init, body: JSON.stringify(body) }
          console.info(`${tag} injected thinking disable params into request body`)
        } catch {
          // Not JSON — pass through unchanged
        }
      }
      return baseFetch(input, init)
    }
  }

  const extraParams = entry.resolve(settings.model, effort)
  // Models without reasoning params AND no reasoning callback don't need
  // the wrapper — they won't emit reasoning_content to track.
  if (!extraParams && !options.onReasoningDelta) {
    console.info(`${tag} skip: no params and no reasoning callback for model=${settings.model}`)
    return undefined
  }

  console.info(
    `${tag} active: model=${settings.model} injecting=${JSON.stringify(extraParams ?? null)} extractReasoning=${!!options.onReasoningDelta}`
  )

  // Only track and inject reasoning_content when the model actually has
  // thinking enabled (extraParams present). Models like deepseek-chat on a
  // recognized host don't emit reasoning_content and must not receive it.
  const thinkingActive = extraParams != null
  const collectedReasoningContents: string[] = thinkingActive
    ? [...(options.historicalReasoningContents ?? [])]
    : []
  let currentReasoningBuffer = ''
  let hasOutstandingResponse = false

  return async (input, init) => {
    if (thinkingActive && hasOutstandingResponse) {
      collectedReasoningContents.push(currentReasoningBuffer)
      currentReasoningBuffer = ''
    }
    hasOutstandingResponse = true

    // 1. Inject thinking params + reasoning_content into request body
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        if (extraParams) Object.assign(body, extraParams)
        if (thinkingActive && Array.isArray(body.messages)) {
          injectReasoningContentIntoMessages(
            body.messages as Array<Record<string, unknown>>,
            collectedReasoningContents
          )
        }
        init = { ...init, body: JSON.stringify(body) }
      } catch {
        // Not JSON — pass through unchanged
      }
    }

    const response = await baseFetch(input, init)

    // 2. Transform response stream to extract reasoning_content
    if (response.body) {
      const transformedBody = createReasoningExtractStream(response.body, (delta) => {
        if (thinkingActive) currentReasoningBuffer += delta
        options.onReasoningDelta?.(delta)
      })
      return new Response(transformedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    }

    return response
  }
}
