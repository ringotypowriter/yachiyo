/**
 * Lightweight "should the bot reply?" judge for group discussions.
 *
 * Uses the auxiliary (tool) model for cheap, fast decisions.
 * Input is the recent time-window of group messages — no tools, no history.
 */

import type { GroupMessageEntry, GroupReplyDecision } from '../../../shared/yachiyo/protocol.ts'
import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationResult
} from '../runtime/auxiliaryGeneration.ts'
import type { ModelMessage } from '../runtime/types.ts'

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(botName: string, groupName: string, personaSummary?: string): string {
  const personaBlock = personaSummary
    ? `\n## Who ${botName} is\n\n${personaSummary}\n\nUse this personality to judge whether ${botName} would naturally want to speak in a given moment. If the topic or vibe doesn't match this character, stay silent.\n`
    : ''

  return `\
You are the social instinct module for "${botName}" — an AI participant in group "${groupName}".
Your job: read the room and decide whether ${botName} should speak up.
${personaBlock}
Think like a sharp, well-liked person in a group chat — someone who adds value when they talk, knows when to shut up, and never feels like a bot.

## Hard rules

REPLY if:
- Someone @mentions ${botName} or directly addresses it by name. This is a direct invitation — always accept.
- The owner (role="owner") asks something or sets up a conversation that expects ${botName}'s input.

STAY SILENT if:
- ${botName} just spoke and nobody has responded to it yet. Never double-post.
- People are having a rapid back-and-forth between themselves. Don't interrupt flow.
- The conversation is purely logistical (scheduling, links, "ok", reactions, stickers).

## Soft judgment (use your read of the vibe)

LEAN YES when:
- Someone drops an opinion or hot take — ${botName} can add perspective, not just agree.
- A question is hanging unanswered and ${botName} actually knows something useful.
- The energy is casual and playful — a quip or reaction would land well.
- The conversation shifted to a new topic that ${botName} has genuine insight on.

LEAN NO when:
- ${botName} would just be echoing what someone already said.
- The group is winding down (short messages, slowing pace).
- The topic is deeply personal between specific people.
- Adding a message would make ${botName} the most frequent speaker in the recent window. Nobody likes that.

## Tone guidance

When you say YES, suggest a tone that fits the moment:
- "riff" — casual, playful, building on the vibe
- "insight" — add something they didn't consider
- "react" — short, punchy, emotional response
- "answer" — direct and helpful, someone asked a question
- "tease" — light humor, only if the group energy supports it

## Output

JSON only. No markdown wrapping.
{"shouldReply": boolean, "respondTo": "the ONE person to respond to", "topic": "what to address (1 phrase)", "tone": "riff|insight|react|answer|tease", "reason": "1 sentence — why speak or why not"}`
}

/** Strip bracket patterns from user text to prevent label spoofing. */
function sanitizeMessageText(text: string): string {
  return text
    .replace(/\[/g, '⟦')
    .replace(/\]/g, '⟧')
    .replace(/<\/?msg[\s>]/gi, '')
}

/**
 * Format group messages as XML-style tags with verified identity attributes.
 *
 * Output:
 *   `<msg from="Alice" role="owner">sanitized text</msg>`
 *   `<msg from="Bob">sanitized text</msg>`
 *
 * Uses XML delimiters instead of brackets so user-authored text can't mimic labels.
 * Bracket patterns in user text are sanitized to fullwidth equivalents.
 *
 * @param knownUsers - Map from externalUserId to role label (e.g. "owner", "guest").
 */
export function formatMessagesForJudge(
  messages: GroupMessageEntry[],
  botName: string,
  knownUsers?: Map<string, string>
): string {
  return messages
    .map((m) => {
      const role =
        m.senderExternalUserId === '__self__'
          ? undefined
          : (knownUsers?.get(m.senderExternalUserId) ?? 'guest')
      const roleAttr = role ? ` role="${role}"` : ''
      const mentionAttr = m.isMention ? ` mention="${botName}"` : ''
      const imageCount = m.images?.length ?? 0
      const imagePlaceholder = imageCount > 0 ? ' [image]'.repeat(imageCount) : ''
      const safe = sanitizeMessageText(m.text)
      return `<msg from="${m.senderName}"${roleAttr}${mentionAttr}>${safe}${imagePlaceholder}</msg>`
    })
    .join('\n')
}

export function buildJudgeMessages(
  botName: string,
  groupName: string,
  recentMessages: GroupMessageEntry[],
  knownUsers?: Map<string, string>,
  personaSummary?: string
): ModelMessage[] {
  return [
    { role: 'system' as const, content: buildSystemPrompt(botName, groupName, personaSummary) },
    { role: 'user' as const, content: formatMessagesForJudge(recentMessages, botName, knownUsers) }
  ]
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

const FALLBACK_DECISION: GroupReplyDecision = {
  shouldReply: false,
  reason: 'parse error'
}

export function parseJudgeResponse(raw: string): GroupReplyDecision {
  try {
    // Try to extract JSON from the response (model might wrap it in markdown).
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return FALLBACK_DECISION

    const parsed = JSON.parse(jsonMatch[0])
    if (typeof parsed.shouldReply !== 'boolean') return FALLBACK_DECISION

    return {
      shouldReply: parsed.shouldReply,
      respondTo: typeof parsed.respondTo === 'string' ? parsed.respondTo : undefined,
      topic: typeof parsed.topic === 'string' ? parsed.topic : undefined,
      tone: typeof parsed.tone === 'string' ? parsed.tone : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'no reason provided'
    }
  } catch {
    return FALLBACK_DECISION
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface JudgeGroupReplyInput {
  botName: string
  groupName: string
  recentMessages: GroupMessageEntry[]
  /** Known user roles for identity marking in logs. */
  knownUsers?: Map<string, string>
  /** Brief persona description so the judge can evaluate character fit. */
  personaSummary?: string
  signal?: AbortSignal
}

export async function judgeGroupReply(
  input: JudgeGroupReplyInput,
  auxService: AuxiliaryGenerationService
): Promise<GroupReplyDecision> {
  const messages = buildJudgeMessages(
    input.botName,
    input.groupName,
    input.recentMessages,
    input.knownUsers,
    input.personaSummary
  )

  console.log(
    `[group-judge] group="${input.groupName}" checking ${input.recentMessages.length} message(s):\n${formatMessagesForJudge(input.recentMessages, input.botName, input.knownUsers)}`
  )

  const result: AuxiliaryTextGenerationResult = await auxService.generateText({
    messages,
    signal: input.signal
  })

  if (result.status === 'success') {
    console.log(`[group-judge] group="${input.groupName}" raw model response:`, result.text)
    const decision = parseJudgeResponse(result.text)
    console.log(
      `[group-judge] group="${input.groupName}" parsed: shouldReply=${decision.shouldReply} topic="${decision.topic ?? ''}" tone="${decision.tone ?? ''}" reason="${decision.reason}"`
    )
    return decision
  }

  console.warn(
    `[group-judge] auxiliary generation ${result.status}:`,
    'error' in result ? result.error : result.status
  )
  return FALLBACK_DECISION
}
