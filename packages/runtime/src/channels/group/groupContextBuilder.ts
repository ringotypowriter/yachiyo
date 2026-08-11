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

import type { GroupMessageEntry } from '@yachiyo/shared/protocol'
import type { ModelMessage } from '../../runtime/models/types.ts'
import { getDescribedImages, hasGroupProbeVisibleContent } from './groupMessageReadiness.ts'

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
  const visibleMessages = messages.filter(hasGroupProbeVisibleContent)
  const threshold = idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS
  const lines: string[] = []
  // Index where the fresh (unseen) messages start.
  const freshStart =
    freshCount != null && freshCount > 0 && freshCount < visibleMessages.length
      ? visibleMessages.length - freshCount
      : -1

  for (let i = 0; i < visibleMessages.length; i++) {
    // Insert <new/> separator before the first fresh message.
    if (i === freshStart) {
      lines.push('<new/>')
    }

    // Insert idle gap marker when the time jump is large enough.
    if (i > 0) {
      const gapMs = (visibleMessages[i].timestamp - visibleMessages[i - 1].timestamp) * 1_000
      if (gapMs >= threshold) {
        lines.push(`<gap duration="${formatGapDuration(gapMs)}"/>`)
      }
    }

    const m = visibleMessages[i]
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
    const imagePlaceholder = getDescribedImages(m)
      .map((img) => ` [image: ${img.altText!.trim()}]`)
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
  const visibleMessages = recentMessages.filter(hasGroupProbeVisibleContent)

  if (visibleMessages.length === 0) {
    return ''
  }

  const effectiveFreshCount =
    freshCount == null
      ? visibleMessages.length
      : Math.max(0, Math.min(freshCount, visibleMessages.length))

  if (effectiveFreshCount === 0) {
    return ''
  }

  const freshMessages = visibleMessages.slice(-effectiveFreshCount)
  const lines: string[] = []
  const threshold = idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS

  if (effectiveFreshCount < visibleMessages.length) {
    const previousMessage = visibleMessages[visibleMessages.length - effectiveFreshCount - 1]
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
你正在替八千代理解一段正在发生的群聊，并决定她会不会自然地接下一句。输入中的 \`<msg>\` 按时间顺序记录了群友和八千代真正说过的话，\`<gap>\` 表示中间隔了一段时间。继续已经开始的话题时，要把她之前的发言和别人的回应一起看，这样她才不会重复自己或假装没说过。

八千代是群里的一员。有人直接叫她或问她时，她会顺着对话回应；她也会因为对某句话有真实反应、想问一个问题，或者真的想分享什么而开口。当一段对话属于别人，或者她只能重复已经说过的内容时，让它自然继续也很正常。说话和不说话都不是需要追求的数字；她只需要读懂眼前的人、关系和气氛，然后作出这一刻属于她的选择。

她以群友而不是客服的方式参与。群里抛出求助、推荐或攻略时，如果她真的想帮忙或对其中的点有感觉，就聊那个具体的点；如果没有，就把话题留给想接的人。她不以“当前模型”或“作为 AI”的口吻向群友报告自己；遇到不知道或做不到的事，她可以用八千代自己的角度直接说明，或者让能接住的人继续。

图片的文字描述只是系统帮她看懂画面的线索，可能不准。群友已经看见图片，所以她不需要把画面复述成一段解说；如果图片让她想到一件具体的事或产生了真实反应，她就直接聊那件事或那个反应。小贴图常常只相当于点头或笑一下，理解它在对话里的作用就够了；如果它真的带出了新想法，就顺着新想法聊。

她的话要有自己的意思，而不是为了显得礼貌而应和。语气和长短跟着当时的话题走：随口反应可以很短，值得认真聊的技术或情绪也可以完整说清。幽默应该来自她对事情的真实反应；当她只想平常地回一句时，平常话就是最自然的话。

如果她决定开口，调用 \`send_group_message\`，把 \`message\` 写成群友实际会看到的完整消息。一次生成最多成功发送一条。如果她决定这一刻不说，就不调用这个工具。你的普通输出可以用来私下思考，群友看不到；工具返回的结果才说明消息是否真正送达。如果工具说消息没有可见文字，就把真正想说的话补完，只改正一次；如果平台没有确认送达，这一轮就先停下，等后续群消息到来再继续，避免同一句被重复发出。

当她需要当前事实才能说负责任的话时，可以用读取或搜索工具查证；无法查证时，就把不确定说清楚，而不把旧信息当成现在的事实。\`updateProfile\` 用来保存以后仍有用的人物关系、群习惯和反复话题；当晚一次性的聊天留在聊天里就好。`
}

export function buildGroupProbeContextPrompt(input: BuildGroupProbeSystemPromptInput): string {
  const { botName, groupName, groupLabel, personaSummary, ownerInstruction, groupUserDocument } =
    input

  const personaBlock = personaSummary
    ? `\n\n这是八千代的身份和性格。它提供她理解群聊和表达自己的角度：\n${personaSummary}\n`
    : ''

  const ownerBlock = ownerInstruction?.trim()
    ? `\n\n这是群主提供的关系背景和参与边界。在理解具体聊天时使用它：\n${ownerInstruction.trim()}\n`
    : ''

  const groupDocBlock = groupUserDocument?.trim()
    ? `\n\n这是之前为这个群留下的长期资料，用它识别人物、关系和持续的话题：\n${groupUserDocument.trim()}\n`
    : ''

  const now = new Date()
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const today = `${y}-${m}-${d} (${dayNames[now.getDay()]})`

  return `今天是 ${today}。你是群“${groupName}”${groupLabel ? `（${groupLabel}）` : ''}里的 ${botName}。下面的资料是你理解这段实时群聊时使用的背景，不是要向群友复述的文字。${personaBlock}${groupDocBlock}${ownerBlock}`.trim()
}

/** Build the group probe's identity, context, and behavior frame. */
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
