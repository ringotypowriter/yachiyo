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

function buildSystemPrompt(botName: string, groupName: string): string {
  return `\
You are a conversation monitor for a chat bot named "${botName}" in group "${groupName}".
Decide whether the bot should reply to the recent messages.

Reply YES when:
- Someone directly addresses or @mentions the bot (this is a very strong signal — almost always reply)
- The topic is something the bot has relevant knowledge about
- There's a natural opening for the bot to contribute
- Someone asks a question the bot can answer

Reply NO when:
- People are having a private side conversation the bot shouldn't interrupt
- The conversation is trivial or logistical (scheduling, reactions)
- The bot has nothing meaningful to add
- The bot recently replied and the conversation hasn't shifted to include it

Output JSON only: {"shouldReply": boolean, "topic": "brief topic if yes", "tone": "suggested tone if yes", "reason": "1 sentence"}`
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
      const safe = sanitizeMessageText(m.text)
      return `<msg from="${m.senderName}"${roleAttr}${mentionAttr}>${safe}</msg>`
    })
    .join('\n')
}

export function buildJudgeMessages(
  botName: string,
  groupName: string,
  recentMessages: GroupMessageEntry[],
  knownUsers?: Map<string, string>
): ModelMessage[] {
  return [
    { role: 'system' as const, content: buildSystemPrompt(botName, groupName) },
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
    input.knownUsers
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
