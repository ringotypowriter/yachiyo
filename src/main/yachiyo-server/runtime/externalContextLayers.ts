/**
 * Context assembly for external channel conversations (Telegram, etc.).
 *
 * Separate from `compileContextLayers` (local desktop) because external channels
 * have a fundamentally different prefix structure: no skills, no local-agent
 * instructions, channel instruction in the stable system prefix, and optional
 * rolling summary between the system prefix and history.
 *
 * History replay is identical to local (full responseMessages) for prompt cache
 * stability. The divergence is in the system prefix and compaction strategy.
 */

import type { ToolCallName } from '../../../shared/yachiyo/protocol.ts'
import {
  compileHintLayer,
  compileMemoryLayer,
  compilePersonalityLayer,
  compileSoulLayer,
  compileUserLayer,
  toModelHistoryMessages,
  type ContextLayerHistoryMessage,
  type HintLayerInput,
  type MemoryLayerInput,
  type PersonalityLayerInput,
  type SoulLayerInput,
  type UserLayerInput
} from './contextLayers.ts'
import type { ModelMessage } from './types.ts'

// ---------------------------------------------------------------------------
// External agent instructions — stripped-down variant for channel contexts
// ---------------------------------------------------------------------------

export function buildExternalAgentInstructions(input: { enabledTools: ToolCallName[] }): string {
  const instructions: string[] = [
    'You have access to investigation tools that let you research, look things up, and read resources to provide better answers.'
  ]

  if (input.enabledTools.length === 0) {
    instructions.push('No tools are available for this run. Respond without tool calls.')
    return instructions.join('\n')
  }

  instructions.push(`Available tools: ${input.enabledTools.join(', ')}.`)

  if (input.enabledTools.includes('grep')) {
    instructions.push('Use grep for text/code search.')
  }

  if (input.enabledTools.includes('glob')) {
    instructions.push('Use glob for file discovery.')
  }

  if (input.enabledTools.includes('read')) {
    instructions.push('Use read for reading file contents.')
  }

  if (input.enabledTools.includes('webRead')) {
    instructions.push(
      'Use webRead for static HTTP(S) resources when you want to read the response body. It extracts readable content from HTML when possible.'
    )
  }

  if (input.enabledTools.includes('webSearch')) {
    instructions.push('Use webSearch for general search results across the web.')
  }

  instructions.push(
    'Never invent file contents, API shapes, configuration keys, or project structures. If you are uncertain, use tools to discover the ground truth before responding.'
  )

  return instructions.join('\n')
}

// ---------------------------------------------------------------------------
// External context layer compilation
// ---------------------------------------------------------------------------

export interface ExternalContextLayersInput {
  personality: PersonalityLayerInput
  soul?: SoulLayerInput
  user?: UserLayerInput
  /** Stable execution contract describing available tools. */
  executionContract: string
  /** Channel-specific reply formatting instruction. */
  channelInstruction: string
  /** Rolling conversation summary from previous compaction. */
  rollingSummary?: string
  /** Full conversation history (same as local — includes responseMessages for cache stability). */
  history: ContextLayerHistoryMessage[]
  /** Per-turn reminders (tool changes, current time). */
  hint?: HintLayerInput
  /** Recalled memory entries. */
  memory?: MemoryLayerInput
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }
    return message.content.length > 0
  })
}

/**
 * Compile context layers for an external channel conversation.
 *
 * Layout (optimized for prompt cache stability):
 *
 * 1. [System] personality + soul + user + execution contract + channel instruction
 *    → Stable across the entire thread lifetime. Cacheable.
 *
 * 2. [User] rolling summary (if present)
 *    → Stable between compaction events. Cacheable.
 *
 * 3. [History] full message history with responseMessages
 *    → Append-only. Previous turns remain cached.
 *
 * 4. [User] hint + memory (injected before the final user message)
 *    → Per-turn volatile tail.
 *
 * 5. [User] current user query
 *    → Always the newest input. Volatile tail.
 */
export function compileExternalContextLayers(input: ExternalContextLayersInput): ModelMessage[] {
  // --- Stable system prefix ---
  // Consolidate personality, soul, user, execution contract, and channel instruction
  // into a single system message to maximize cache hit rate.
  const systemParts: string[] = []

  const personalityMsg = compilePersonalityLayer(input.personality)
  if (personalityMsg) {
    systemParts.push(personalityMsg.content as string)
  }

  const soulMsg = compileSoulLayer(input.soul)
  if (soulMsg) {
    systemParts.push(soulMsg.content as string)
  }

  const userMsg = compileUserLayer(input.user)
  if (userMsg) {
    systemParts.push(userMsg.content as string)
  }

  if (input.executionContract.trim()) {
    systemParts.push(input.executionContract.trim())
  }

  if (input.channelInstruction.trim()) {
    systemParts.push(input.channelInstruction.trim())
  }

  const systemPrefix: ModelMessage[] =
    systemParts.length > 0 ? [{ role: 'system', content: systemParts.join('\n\n') }] : []

  // --- Rolling summary (stable between compactions) ---
  const summaryMessages: ModelMessage[] = input.rollingSummary?.trim()
    ? [
        {
          role: 'user',
          content: [
            '<conversation_summary>',
            input.rollingSummary.trim(),
            '</conversation_summary>'
          ].join('\n')
        }
      ]
    : []

  // --- History (full, including responseMessages — cache-optimal) ---
  const historyMessages = input.history.flatMap(toModelHistoryMessages)

  // --- Per-turn context (hint + memory, injected before last user message) ---
  const turnContextLayers: ModelMessage[] = [
    compileHintLayer(input.hint),
    compileMemoryLayer(input.memory)
  ].flatMap((message) =>
    message ? [{ role: 'user' as const, content: message.content as string }] : []
  )

  if (turnContextLayers.length === 0) {
    return removeEmptyMessages([...systemPrefix, ...summaryMessages, ...historyMessages])
  }

  // Insert turn context immediately before the current user query (last user message in history).
  let insertIndex = historyMessages.length
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    if (historyMessages[i].role === 'user') {
      insertIndex = i
      break
    }
  }

  return removeEmptyMessages([
    ...systemPrefix,
    ...summaryMessages,
    ...historyMessages.slice(0, insertIndex),
    ...turnContextLayers,
    ...historyMessages.slice(insertIndex)
  ])
}
