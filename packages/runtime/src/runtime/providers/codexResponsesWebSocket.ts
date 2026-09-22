import {
  createResponsesWebSocketFetch,
  type ResponsesWebSocketFetchOptions
} from './responsesWebSocket.ts'

export { ResponsesWebSocketPool as CodexWebSocketPool } from './responsesWebSocket.ts'
export type CodexWebSocketFetchOptions = Omit<ResponsesWebSocketFetchOptions, 'codex'>

/** Preserve Codex routing/auth metadata without applying it to generic providers. */
export function createCodexWebSocketFetch(
  baseFetch: typeof globalThis.fetch,
  options: CodexWebSocketFetchOptions
): typeof globalThis.fetch {
  return createResponsesWebSocketFetch(baseFetch, { ...options, codex: true })
}
