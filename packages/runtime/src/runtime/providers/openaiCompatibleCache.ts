/**
 * Fetch wrapper that injects `cache_control` markers into the request body
 * for OpenAI-compatible hosts that support DashScope-style explicit context
 * caching (same format as Anthropic: `cache_control: {"type": "ephemeral"}`
 * on message content blocks).
 *
 * The `@ai-sdk/openai` SDK formats system messages as plain strings and
 * strips unknown fields, so the markers must be injected at the fetch layer.
 */

const CACHE_CONTROL_EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Hosts whose OpenAI-compatible chat completions endpoints accept
 * `cache_control` on message content blocks.
 */
const CACHE_HOSTS: readonly string[] = ['dashscope.aliyuncs.com']

function matchesCacheHost(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).host
  } catch {
    return false
  }
  return CACHE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * Whether the given base URL points to a host that supports explicit
 * `cache_control` markers on message content blocks.
 */
export function isExplicitCacheHost(baseUrl: string): boolean {
  return matchesCacheHost(baseUrl)
}

interface ChatMessage {
  role: string
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
}

/**
 * Mark a single message with `cache_control: {"type": "ephemeral"}` on its
 * last content block, converting string content to array format if needed.
 */
function markMessage(msg: ChatMessage): ChatMessage {
  const content = msg.content
  if (typeof content === 'string') {
    return {
      ...msg,
      content: [{ type: 'text', text: content, cache_control: CACHE_CONTROL_EPHEMERAL }]
    }
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = [...content]
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: CACHE_CONTROL_EPHEMERAL
    }
    return { ...msg, content: blocks }
  }
  return msg
}

/**
 * Inject `cache_control: {"type": "ephemeral"}` breakpoints:
 *
 * 1. Last system message — caches the stable system prefix.
 * 2. Last message before the final user message — caches system + history.
 *
 * DashScope allows max 4 breakpoints; we use 2 for the natural boundaries.
 */
function injectCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] {
  const result = [...messages]

  // Breakpoint 1: last system message.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'system') {
      result[i] = markMessage(result[i])
      break
    }
  }

  // Breakpoint 2: message just before the last user message (history boundary).
  let lastUserIdx = -1
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx > 0) {
    result[lastUserIdx - 1] = markMessage(result[lastUserIdx - 1])
  }

  return result
}

/**
 * Create a fetch wrapper that injects `cache_control` breakpoints into
 * system messages for compatible hosts.
 *
 * Returns `undefined` when the host is not recognised, so callers can
 * fall through to the default fetch.
 */
export function createCacheFetch(
  baseUrl: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch | undefined {
  const tag = '[yachiyo][openai-compat-cache]'

  if (!matchesCacheHost(baseUrl)) {
    return undefined
  }

  console.info(`${tag} active: injecting cache_control breakpoints for host`)

  return async (input, init) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        if (Array.isArray(body.messages)) {
          body.messages = injectCacheBreakpoints(body.messages as ChatMessage[])
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch {
        // Not JSON — pass through unchanged
      }
    }
    return baseFetch(input, init)
  }
}
