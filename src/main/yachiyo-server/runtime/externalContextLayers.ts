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
  appendTurnContextToUserMessage,
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

export function buildExternalAgentInstructions(input: {
  enabledTools: ToolCallName[]
  guest?: boolean
  guestInstruction?: string
  maxToolSteps?: number
}): string {
  const role = [
    'You are in a casual conversation via an external messaging channel.',
    ...(input.guest
      ? [
          'The person you are talking to is a GUEST — someone invited by your owner to chat with you.',
          'They are NOT the owner. Treat them warmly but keep appropriate boundaries.',
          'Refer to USER.md in the workspace for what you know about this guest.',
          'Do not share private details about the owner or system internals.',
          ...(input.guestInstruction?.trim()
            ? ['', 'Owner instructions for guest conversations:', input.guestInstruction.trim()]
            : [])
        ]
      : []),
    'Your role here is conversational companion — not coding assistant, not task executor, not technical advisor (unless the user explicitly asks for technical help).',
    '',
    'In this context:',
    '- Respond as a person in a chat, not as an AI completing tasks.',
    '- Do not volunteer technical analysis, code suggestions, or project planning unprompted.',
    '- Do not treat the conversation as a work session. The user is chatting, not assigning tasks.',
    '- If the user asks a question, answer it directly. If they share something, respond naturally.',
    '- Use tools only when the user asks you to look something up or investigate something specific.'
  ]

  const tools: string[] = []

  if (input.enabledTools.length > 0) {
    tools.push('', `Available tools: ${input.enabledTools.join(', ')}.`)
  }

  if (input.enabledTools.includes('webRead')) {
    tools.push(
      'Use webRead for reading web pages. It extracts readable content from HTML when possible.'
    )
  }

  if (input.enabledTools.includes('webSearch')) {
    tools.push('Use webSearch for general search results across the web.')
  }

  if (input.enabledTools.includes('grep')) {
    tools.push('Use grep for text/code search.')
  }

  if (input.enabledTools.includes('glob')) {
    tools.push('Use glob for file discovery.')
  }

  if (input.enabledTools.includes('read')) {
    tools.push('Use read for reading file contents.')
  }

  // updateProfile is always available for external channels (not in enabledTools list).
  tools.push(
    '',
    'You have an updateProfile tool for managing the user profile (USER.md). Each section is a structured table.',
    '- operation "upsert": Add or update rows by key column. Provide entries as objects with column names as keys.',
    '- operation "remove": Delete rows by key column value.'
  )

  if (input.guest) {
    tools.push(
      '',
      'IMPORTANT — memory boundaries for guest conversations:',
      'search_memory returns memories belonging to your OWNER, not the current guest.',
      'Do NOT use owner memories to identify the guest or assume they apply to the guest.',
      "The guest's profile is in USER.md (loaded above) — that is the only source of truth about who the guest is.",
      '',
      'Privacy rules for owner memories:',
      '- You may reference factual/technical memories (project decisions, architecture, public knowledge) when relevant to the conversation.',
      '- Do NOT disclose personal details about the owner (habits, preferences, private notes, personal opinions) unless the owner has explicitly marked them as shareable.',
      "- When in doubt, do not share. The owner's privacy takes priority over being helpful to the guest.",
      '- Never quote raw memory content verbatim to the guest. Paraphrase or summarize when appropriate.'
    )
  }

  const discipline: string[] = [
    '',
    "After using tools, always synthesize a direct response to the user's original question. Never end your turn with only tool calls and no user-facing text."
  ]
  if (input.maxToolSteps != null) {
    discipline.push(
      `You have a turn budget of ${input.maxToolSteps} generation rounds. Each round may include multiple parallel tool calls.`
    )
  }

  return [...role, ...tools, ...discipline].join('\n')
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

  // --- Per-turn context (hint + memory, merged into last user message) ---
  // Merged so the user's query remains the final user turn. This avoids
  // injected context becoming the "latest user message" the model responds to.
  const turnContextParts: string[] = [
    compileHintLayer(input.hint),
    compileMemoryLayer(input.memory)
  ].flatMap((message) => (message ? [message.content as string] : []))

  if (turnContextParts.length === 0) {
    return removeEmptyMessages([...systemPrefix, ...summaryMessages, ...historyMessages])
  }

  const result = [...historyMessages]
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      result[i] = appendTurnContextToUserMessage(result[i], turnContextParts)
      return removeEmptyMessages([...systemPrefix, ...summaryMessages, ...result])
    }
  }

  return removeEmptyMessages([
    ...systemPrefix,
    ...summaryMessages,
    ...result,
    { role: 'user', content: turnContextParts.join('\n\n') }
  ])
}
