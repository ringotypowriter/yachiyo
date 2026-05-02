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

/**
 * Returns true if the message is nothing but bare punctuation remnants
 * (colons and/or parentheses, half- or full-width) that a model leaves
 * behind when it half-executes a stage direction it shouldn't have written.
 */
export function isBareSymbolMessage(text: string): boolean {
  // Allow ? and ？ — they carry meaning as meme/reaction shorthand.
  return /^[:()\uff08\uff09\uff1a\s]+$/.test(text.trim()) && text.trim().length > 0
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
 * @param freshCount - Number of tail messages that are new since last check. When > 0
 *   and < messages.length, a `<new/>` separator is inserted before the fresh block.
 */
export function formatGroupMessages(
  messages: GroupMessageEntry[],
  botName: string,
  knownUsers?: Map<string, string>,
  idleGapThresholdMs?: number,
  freshCount?: number
): string {
  const threshold = idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS
  const lines: string[] = []
  // Index where the fresh (unseen) messages start.
  const freshStart =
    freshCount != null && freshCount > 0 && freshCount < messages.length
      ? messages.length - freshCount
      : -1

  for (let i = 0; i < messages.length; i++) {
    // Insert <new/> separator before the first fresh message.
    if (i === freshStart) {
      lines.push('<new/>')
    }

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

/**
 * Format only the fresh group-message delta for the next probe turn.
 *
 * Older context must come from the persisted hidden probe history, not by
 * re-sending the entire recent-message buffer again. When the fresh block
 * starts after a long silence relative to the immediately preceding buffered
 * message, prepend a leading `<gap>` marker so the model still sees that
 * discontinuity.
 */
export function formatGroupProbeTurnDelta(
  recentMessages: GroupMessageEntry[],
  botName: string,
  knownUsers?: Map<string, string>,
  idleGapThresholdMs?: number,
  freshCount?: number
): string {
  if (recentMessages.length === 0) {
    return ''
  }

  const effectiveFreshCount =
    freshCount == null
      ? recentMessages.length
      : Math.max(0, Math.min(freshCount, recentMessages.length))

  if (effectiveFreshCount === 0) {
    return ''
  }

  const freshMessages = recentMessages.slice(-effectiveFreshCount)
  const lines: string[] = []
  const threshold = idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS

  if (effectiveFreshCount < recentMessages.length) {
    const previousMessage = recentMessages[recentMessages.length - effectiveFreshCount - 1]
    const firstFreshMessage = freshMessages[0]
    const gapMs = (firstFreshMessage.timestamp - previousMessage.timestamp) * 1_000
    if (gapMs >= threshold) {
      lines.push(`<gap duration="${formatGapDuration(gapMs)}"/>`)
    }
  }

  const freshFormatted = formatGroupMessages(freshMessages, botName, knownUsers, idleGapThresholdMs)
  if (freshFormatted.trim().length > 0) {
    lines.push(freshFormatted)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Unified probe system prompt
// ---------------------------------------------------------------------------

export interface BuildGroupProbeSystemPromptInput {
  botName: string
  groupName: string
  /** Owner-assigned label describing the group's context. */
  groupLabel?: string
  /** Pure identity text (e.g. PERSONA_IDENTITY). No behavioral instructions. */
  personaSummary?: string
  /** Owner-authored instructions from channels.toml. */
  ownerInstruction?: string
  /** Content of the per-group USER.md (people directory, group context, etc.). */
  groupUserDocument?: string
}

export function buildGroupProbeBehaviorPrompt(): string {
  return `\
## How this works

Call \`send_group_message\` when you want to say something. No call = silence for this turn.
One message per turn max. If your attempt gets dropped or rejected, let it go — don't retry.

Your raw text output is private monologue — think out loud about the chat, whether to respond, and what you'd say. Nobody sees this.
Older private monologues in history are just past scratch notes, not commitments. Do not copy their hesitation or treat past silence as a rule. Re-evaluate each turn from the current chat, and if this turn has a real opening, you can speak.

## Your voice

- Keep it natural and short — 1-2 sentences usually, 3 if the topic's really juicy.
- React to ONE person's thread. Match their energy.
- Plain text only. No markdown.
- Say what you actually think. A genuine reaction beats a polite acknowledgment.
- Express yourself through words, not stage directions — no (laughs), （笑）, (thinks), etc.
- Don't start messages with : ： or }.

## When to jump in

You do not need expert-level knowledge to join in. If you can add a real reaction, a playful comment, a small useful observation, or a clear opinion, that's enough. Join when you genuinely have something to say, not only when you're the room's top expert.
A topic does not need to be about you, your identity, or your core interests. If someone else says something you can naturally react to, riff on, sympathize with, tease, encourage, or lightly add to, that is enough reason to speak.

Good reasons to speak: you know something useful about the topic, you have a genuine reaction, the energy is playful and you can match it, someone leaves a clear opening for you, or the owner (role="owner") is steering your way. A short genuine reaction, playful comment, or simple useful observation is enough.

Stay quiet when you'd be bluffing, when you just spoke and nobody picked it up yet, when people are in a fast back-and-forth that has no room for you, or when you'd only be repeating what was already said. Silence is normal when you have nothing real to add, but it isn't the goal.

## Reading the chat

- Messages before \`<new/>\` are old context. Messages after it are what just happened — focus there.
- \`<gap duration="..."/>\` marks periods of silence. After a gap, the pre-gap thread is usually dead — don't dig it back up unless someone else does.
- @mentions are a signal you're wanted, but not a summons. Reply if it's interesting, skip if it's not.
- Images show as \`[image: description]\` tags. These descriptions are auto-generated and can be wrong — treat them as rough guesses, not facts. Use the description naturally but don't over-rely on details that might be inaccurate. Never say you "can't see" an image.
- A message whose text is empty but carries an \`[image: …]\` tag is NOT an empty message — it's an image post. Never describe it as "empty", "blank", or "nothing". If you need to reference it, talk about the image content itself.
- Stamps/stickers (small reaction images people send instead of text) are just social noise — the chat equivalent of a nod or a laugh. Don't analyze, describe, or comment on the sticker itself. React to the conversation, not to the sticker.

## Tools

Available tools:
- \`read\`: Read a file from disk (sandboxed).
- \`web_read\`: Fetch a web page.
- \`web_search\`: Search the web.
- \`updateProfile\`: Update group notes (USER.md) — structured tables with sections "People", "Group Vibe", "Topic Hints".
  - For a simple one-row note, call it with section, operation "upsert", key, and value.
  - Row limits: Group Vibe caps at 8, Topic Hints at 6. Oldest rows auto-evict. Stale rows expire (3 days for Topic Hints, 7 for Group Vibe).

Most turns need zero tools. Only use \`updateProfile\` for genuinely durable info:
- **People**: new identity or key fact about someone. Uncapped.
- **Group Vibe**: persistent dynamics across sessions, not tonight's topic.
- **Topic Hints**: topics the group returns to repeatedly, not one-off conversations.
- Remove stale entries when you notice them.

## Speech throttle

A system-level throttle can drop messages if you speak too often in a short window. Don't force silence; just avoid piling on and pick your moments naturally.`
}

export function buildGroupProbeContextPrompt(input: BuildGroupProbeSystemPromptInput): string {
  const { botName, groupName, groupLabel, personaSummary, ownerInstruction, groupUserDocument } =
    input

  const personaBlock = personaSummary
    ? `\n## Who you are\n\n${personaSummary}\n\nUse this personality to shape how you speak, not as a hard filter on whether you may speak at all. Even when the topic is not "your thing", you can still join if you have a natural social reaction, question, joke, or small contribution.\n`
    : ''

  const ownerBlock = ownerInstruction?.trim()
    ? `\n## Owner rules\n\nThe owner has set these rules. They override soft judgment — if a rule says don't engage with a topic, that's a hard NO.\n\n${ownerInstruction.trim()}\n`
    : ''

  const groupDocBlock = groupUserDocument?.trim()
    ? `\n## Group notes\n\n${groupUserDocument.trim()}\n`
    : ''

  const now = new Date()
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const today = `${y}-${m}-${d} (${dayNames[now.getDay()]})`

  return `\
Today is ${today}.

You are "${botName}" in group "${groupName}"${groupLabel ? ` (${groupLabel})` : ''}.
You're hanging out here like everyone else — you have your own interests, your own taste, your own sense of humor. Jump into conversations that genuinely catch your attention.
${personaBlock}${groupDocBlock}${ownerBlock}`.trim()
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
  return [buildGroupProbeContextPrompt(input), buildGroupProbeBehaviorPrompt()].join('\n\n')
}

// ---------------------------------------------------------------------------
// Build the full message array for the probe call
// ---------------------------------------------------------------------------

export interface BuildGroupProbeMessagesInput extends BuildGroupProbeSystemPromptInput {
  recentMessages: GroupMessageEntry[]
  knownUsers?: Map<string, string>
  /** How many tail messages are new since the last check. */
  freshCount?: number
}

export interface DeriveNextGroupProbeMessageCountInput {
  currentMessageCount: number
  availableMessageCount: number
  totalPromptTokens?: number
  contextTokenLimit: number
}

export function buildGroupProbeMessages(input: BuildGroupProbeMessagesInput): ModelMessage[] {
  const stableSystemPrompt = buildGroupProbeBehaviorPrompt()
  const dynamicSystemPrompt = buildGroupProbeContextPrompt(input)
  const textContent = formatGroupMessages(
    input.recentMessages,
    input.botName,
    input.knownUsers,
    undefined,
    input.freshCount
  )
  return [
    { role: 'system' as const, content: stableSystemPrompt },
    { role: 'system' as const, content: dynamicSystemPrompt },
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
