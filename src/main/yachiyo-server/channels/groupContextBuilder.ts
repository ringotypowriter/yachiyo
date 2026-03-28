/**
 * Context assembly helpers for group discussion replies.
 *
 * Extends the external-channel context pattern with:
 *   1. Identity-labeled message formatting ([Alice] text, [Yachiyo] text)
 *   2. Group-specific channel instruction (topic/tone from the judge decision)
 */

import type { GroupReplyDecision } from '../../../shared/yachiyo/protocol.ts'
import { CHANNEL_REPLY_HINT } from './channelReply.ts'

// ---------------------------------------------------------------------------
// Group reply instruction
// ---------------------------------------------------------------------------

/**
 * Build a channel instruction for group reply generation.
 *
 * Wraps the base {@link CHANNEL_REPLY_HINT} with group-awareness context
 * and the judge's topic/tone guidance.
 */
export function buildGroupReplyInstruction(decision: GroupReplyDecision, botName: string): string {
  const parts: string[] = [CHANNEL_REPLY_HINT]

  parts.push(`\n<group_context>`)
  parts.push(`You are participating in a group conversation as "${botName}".`)

  if (decision.topic) {
    parts.push(`The current topic to address: ${decision.topic}`)
  }
  if (decision.tone) {
    parts.push(`Suggested tone: ${decision.tone}`)
  }

  parts.push(`Address people by name when responding directly to them.`)
  parts.push(`Don't reply to everything — only when you have something meaningful to add.`)
  parts.push(`Keep the group vibe natural. You're one participant, not the host.`)
  parts.push(`</group_context>`)

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Message formatting with identity labels
// ---------------------------------------------------------------------------

export interface LabeledMessage {
  senderName: string | null
  role: 'user' | 'assistant'
  content: string
}

/**
 * Format a sequence of messages with `[Name]` identity prefixes.
 *
 * - User messages with a `senderName` get `[SenderName] content`
 * - Assistant (bot) messages get `[botName] content`
 * - Messages without a sender name (legacy DM) are left as-is
 */
export function formatGroupMessages(messages: LabeledMessage[], botName: string): string {
  return messages
    .map((m) => {
      if (m.role === 'assistant') return `[${botName}] ${m.content}`
      if (m.senderName) return `[${m.senderName}] ${m.content}`
      return m.content
    })
    .join('\n')
}
