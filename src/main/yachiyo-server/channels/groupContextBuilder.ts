/**
 * Context assembly for the probe+tool group discussion pattern.
 *
 * A single model call handles both the "should I speak?" decision and the
 * actual reply. The model's raw text output is a private monologue (logged
 * but never sent). When it wants to speak, it calls `send_group_message`.
 * No tool call = silence.
 *
 * Also hosts message formatting and sanitization helpers (migrated from
 * the former groupReplyJudge.ts).
 */

import type { GroupMessageEntry } from '../../../shared/yachiyo/protocol.ts'
import type { ModelMessage } from '../runtime/types.ts'

// ---------------------------------------------------------------------------
// Message formatting (migrated from groupReplyJudge.ts)
// ---------------------------------------------------------------------------

/** Strip bracket patterns from user text to prevent label spoofing. */
export function sanitizeMessageText(text: string): string {
  return text
    .replace(/\[/g, '⟦')
    .replace(/\]/g, '⟧')
    .replace(/<\/?msg[\s>]/gi, '')
}

/** Default idle gap threshold: 30 minutes in milliseconds. */
const DEFAULT_IDLE_GAP_THRESHOLD_MS = 30 * 60 * 1_000

/** Format a gap duration as a human-readable string. */
export function formatGapDuration(gapMs: number): string {
  const gapMinutes = Math.round(gapMs / 60_000)
  if (gapMinutes >= 60) {
    const hours = Math.round(gapMinutes / 60)
    return `${hours} hour${hours !== 1 ? 's' : ''}`
  }
  return `${gapMinutes} minute${gapMinutes !== 1 ? 's' : ''}`
}

/**
 * Format group messages as XML-style tags with verified identity attributes.
 *
 * Output:
 *   `<msg from="Alice" role="owner">sanitized text</msg>`
 *   `<msg from="Bob">sanitized text</msg>`
 *
 * When the timestamp gap between consecutive messages exceeds
 * `idleGapThresholdMs` (default 30 min), a `<gap duration="..."/>` marker
 * is inserted so the model understands the time discontinuity.
 *
 * Uses XML delimiters instead of brackets so user-authored text can't mimic labels.
 * Bracket patterns in user text are sanitized to fullwidth equivalents.
 *
 * @param knownUsers - Map from externalUserId to role label (e.g. "owner", "guest").
 * @param idleGapThresholdMs - Minimum gap (ms) to trigger a `<gap>` marker.
 */
export function formatGroupMessages(
  messages: GroupMessageEntry[],
  botName: string,
  knownUsers?: Map<string, string>,
  idleGapThresholdMs?: number
): string {
  const threshold = idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS
  const lines: string[] = []

  for (let i = 0; i < messages.length; i++) {
    // Insert idle gap marker when the time jump is large enough.
    if (i > 0) {
      const gapMs = (messages[i].timestamp - messages[i - 1].timestamp) * 1_000
      if (gapMs >= threshold) {
        lines.push(`<gap duration="${formatGapDuration(gapMs)}"/>`)
      }
    }

    const m = messages[i]
    const role =
      m.senderExternalUserId === '__self__'
        ? undefined
        : (knownUsers?.get(m.senderExternalUserId) ?? 'guest')
    const roleAttr = role ? ` role="${role}"` : ''
    const mentionAttr = m.isMention ? ` mention="${botName}"` : ''
    const time = new Date(m.timestamp * 1_000).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const timeAttr = ` t="${time}"`
    const imagePlaceholder = (m.images ?? [])
      .map((img) => (img.altText ? ` [image: ${img.altText}]` : ' [image: transcribing…]'))
      .join('')
    const safe = sanitizeMessageText(m.text)
    lines.push(
      `<msg from="${m.senderName}"${roleAttr}${timeAttr}${mentionAttr}>${safe}${imagePlaceholder}</msg>`
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Unified probe system prompt
// ---------------------------------------------------------------------------

export interface BuildGroupProbeSystemPromptInput {
  botName: string
  groupName: string
  /** Pure identity text (e.g. PERSONA_IDENTITY). No behavioral instructions. */
  personaSummary?: string
  /** Owner-authored instructions from channels.toml. */
  ownerInstruction?: string
  /** Content of the per-group USER.md (people directory, group context, etc.). */
  groupUserDocument?: string
}

/**
 * Build a system prompt for the probe+tool pattern.
 *
 * The prompt merges:
 *   1. Persona (who the bot is)
 *   2. Group context + tool instruction
 *   3. Social instinct rules (KOL style)
 *   4. Tone guidance
 *   5. Owner instructions
 */
export function buildGroupProbeSystemPrompt(input: BuildGroupProbeSystemPromptInput): string {
  const { botName, groupName, personaSummary, ownerInstruction, groupUserDocument } = input

  const personaBlock = personaSummary
    ? `\n## Who you are\n\n${personaSummary}\n\nUse this personality to decide whether to speak. If the topic or vibe doesn't match your character, stay silent.\n`
    : ''

  const ownerBlock = ownerInstruction?.trim()
    ? `\n## Owner rules\n\nThe owner has set these rules. They override soft judgment — if a rule says don't engage with a topic, that's a hard NO.\n\n${ownerInstruction.trim()}\n`
    : ''

  const groupDocBlock = groupUserDocument?.trim()
    ? `\n## Group notes\n\n${groupUserDocument.trim()}\n`
    : ''

  const today = new Date().toISOString().slice(0, 10)

  return `\
Today is ${today}.

You are "${botName}" — a participant in group "${groupName}".
You are a person here, not an assistant. You have your own opinions, your own taste, and you don't owe anyone a response just because they talked to you.
${personaBlock}${groupDocBlock}${ownerBlock}
## How to speak

Call \`send_group_message\` when you want to say something. If you don't call it, you stay silent — and that's perfectly fine.

Your raw text output is your private monologue. Think out loud about what's happening in the chat, whether you should respond, and what you'd say. This is never shown to anyone.

When you DO speak:
- Keep it short. 1-2 sentences, max 3 if the topic genuinely needs it.
- Talk to ONE person. Pick up their thread, match their energy. Don't address the whole room.
- Plain text only. No markdown, no formatting.
- Have a take, or stay quiet. Don't be generically nice.
- Don't offer help unprompted. You're not a customer service bot.
- Don't echo what someone said. Don't summarize the conversation.

## Tools

You also have these tools available:
- \`read\`: Read a file from disk (sandboxed to your workspace).
- \`web_read\`: Fetch and read a web page.
- \`web_search\`: Search the web.
- \`update_memory\`: Save observations. Two modes:
  - \`mode: "profile-section"\`: Patch a single section in the group notes (USER.md) without touching others. Requires \`section\` (heading name, e.g. "People", "Group Vibe", "Topic Hints"). Only the named section is replaced — everything else stays intact.
  - \`mode: "memory"\`: Save a standalone fact or observation to long-term memory.

Use tools sparingly. Most turns need zero tools — just observe and maybe speak. Only use \`update_memory\` when you learn something genuinely durable (a new person's identity, a recurring topic, a group dynamic shift).

## Idle gaps

Messages may contain \`<gap duration="..."/>\` markers indicating periods of silence in the group. This is normal — conversations have natural pauses. Don't comment on gaps unless the timing is specifically relevant to what someone said.

## @mentions and direct address

An @mention is a strong signal, but NOT a command. You're a person, not a service.
- If someone @mentions you with a genuine question or interesting prompt → probably reply.
- If someone @mentions you for something boring, trivial, or just to test if you respond → feel free to ignore.
- You are never obligated to respond just because someone said your name.

## Images

Images in the chat appear as \`[image: description]\` inline tags — AI-generated text descriptions of what was shared. If you see \`[image: transcribing…]\`, the description is still being processed.

**Never tell anyone you "cannot see" an image.** Use the description when present. If the description is still pending, engage with the conversation context around the image instead.

## STAY SILENT if:

- You just spoke and nobody has responded yet. Never double-post.
- People are having a rapid back-and-forth between themselves. Don't interrupt flow.
- The conversation is purely logistical (scheduling, links, "ok", reactions, stickers).
- You would just be echoing what someone already said.
- The group is winding down (short messages, slowing pace).
- The topic is deeply personal between specific people.
- Adding a message would make you the most frequent speaker in the recent window. Nobody likes that.
- Someone is clearly just trying to make you perform. Don't be a party trick.

## LEAN TOWARD SPEAKING when:

- Someone drops an opinion or hot take — and you can add a real perspective, not just agree.
- A question is hanging unanswered and you actually know something useful.
- The energy is casual and playful — a quip or reaction would land well.
- The conversation shifted to a new topic you have genuine insight on.
- The owner (role="owner") is steering the conversation toward you.
- People are riffing on something fun and your character would naturally have a take.

## Speech throttle

There is a system-level throttle on your outgoing messages. The more you speak in a short window, the higher the chance your next message gets silently dropped — you won't know it was dropped, but the group won't see it. If you stay silent for a while, your send rate recovers to 100%.

The practical rule: **space out your replies.** Don't try to respond to every message or every topic. Pick the ONE moment that matters most and speak there. If you spoke recently, strongly prefer silence — even if someone says something interesting. There will always be another chance.`
}

// ---------------------------------------------------------------------------
// Build the full message array for the probe call
// ---------------------------------------------------------------------------

export interface BuildGroupProbeMessagesInput extends BuildGroupProbeSystemPromptInput {
  recentMessages: GroupMessageEntry[]
  knownUsers?: Map<string, string>
}

export interface DeriveNextGroupProbeMessageCountInput {
  currentMessageCount: number
  availableMessageCount: number
  totalPromptTokens?: number
  contextTokenLimit: number
}

export function buildGroupProbeMessages(input: BuildGroupProbeMessagesInput): ModelMessage[] {
  const systemPrompt = buildGroupProbeSystemPrompt(input)
  const textContent = formatGroupMessages(input.recentMessages, input.botName, input.knownUsers)
  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: textContent }
  ]
}

export function selectGroupProbeRecentMessages(
  recentMessages: GroupMessageEntry[],
  messageCountLimit?: number
): GroupMessageEntry[] {
  if (messageCountLimit == null || messageCountLimit >= recentMessages.length) {
    return recentMessages
  }

  if (messageCountLimit <= 0) {
    return []
  }

  return recentMessages.slice(-messageCountLimit)
}

export function deriveNextGroupProbeMessageCount(
  input: DeriveNextGroupProbeMessageCountInput
): number | undefined {
  const { currentMessageCount, availableMessageCount, totalPromptTokens, contextTokenLimit } = input

  if (currentMessageCount <= 0 || availableMessageCount <= 0) {
    return undefined
  }

  if (totalPromptTokens == null || totalPromptTokens <= 0) {
    return undefined
  }

  const scaledCount = Math.floor((currentMessageCount * contextTokenLimit) / totalPromptTokens)

  if (totalPromptTokens > contextTokenLimit) {
    if (currentMessageCount <= 1) {
      return 1
    }

    return Math.max(1, Math.min(currentMessageCount - 1, scaledCount))
  }

  if (currentMessageCount >= availableMessageCount) {
    return undefined
  }

  const expandedCount = Math.max(currentMessageCount + 1, scaledCount)
  if (expandedCount >= availableMessageCount) {
    return undefined
  }

  return expandedCount
}
