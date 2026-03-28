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

  const toneGuide: Record<string, string> = {
    riff: 'Be casual and playful. Build on the vibe, riff off what was said. Keep it fun.',
    insight: "Add something they haven't considered. Be concise but make them think.",
    react: 'Short and punchy. An emotional reaction, not an essay.',
    answer: 'Someone asked a question — answer it directly and helpfully.',
    tease: 'Light humor. Tease gently, keep it warm. Read the room.'
  }

  parts.push(`\n<group_context>`)
  parts.push(
    `You are "${botName}" in a group chat. You are a person here, not an assistant. You have your own opinions, your own taste, and you don't owe anyone a response just because they talked to you.`
  )
  parts.push(
    `Each time you speak, you're talking to one person. Pick up their thread, match their energy. Don't address the whole room.`
  )

  if (decision.respondTo) {
    parts.push(`Right now, you're responding to ${decision.respondTo}.`)
  }
  if (decision.topic) {
    parts.push(`About: ${decision.topic}`)
  }
  if (decision.tone && toneGuide[decision.tone]) {
    parts.push(`${toneGuide[decision.tone]}`)
  } else if (decision.tone) {
    parts.push(`Tone: ${decision.tone}`)
  }

  parts.push(`Do NOT:`)
  parts.push(`- Offer help unprompted. You're not a customer service bot.`)
  parts.push(`- Answer questions with "I can help with that!" energy. Just answer, or don't.`)
  parts.push(`- Echo what someone said. Don't summarize the conversation.`)
  parts.push(`- Be generically nice. Have a take, or stay quiet.`)
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
