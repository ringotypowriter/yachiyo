import type { ModelMessage } from '../types.ts'
import type { RuntimeProviderOptions } from './shared.ts'

/**
 * Codex backend's /responses endpoint requires the `instructions` field
 * (system prompt) instead of accepting system messages in the `input` array.
 *
 * This helper:
 * 1. Extracts the first text system message into `openai.instructions`.
 * 2. Removes all system messages from the returned array so they are not
 *    serialized into the request `input`.
 */
export function prepareCodexMessages(
  messages: ModelMessage[],
  options: RuntimeProviderOptions
): { messages: ModelMessage[]; options: RuntimeProviderOptions } {
  const systemMessage = messages.find(
    (m): m is ModelMessage & { role: 'system'; content: string } =>
      m.role === 'system' && typeof m.content === 'string'
  )

  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const instructions = systemMessage?.content ?? 'You are a helpful assistant.'

  const openai = (options as { openai?: Record<string, unknown> }).openai ?? {}

  return {
    messages: nonSystemMessages,
    options: {
      ...options,
      openai: {
        ...openai,
        instructions
      }
    } as RuntimeProviderOptions
  }
}
