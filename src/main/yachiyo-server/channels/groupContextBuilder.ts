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
import { extractBase64DataUrlPayload } from '../../../shared/yachiyo/messageContent.ts'
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
export function formatGroupMessages(
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
      const time = new Date(m.timestamp * 1_000).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
      const timeAttr = ` t="${time}"`
      const imageCount = m.images?.length ?? 0
      const imagePlaceholder = imageCount > 0 ? ' [image]'.repeat(imageCount) : ''
      const safe = sanitizeMessageText(m.text)
      return `<msg from="${m.senderName}"${roleAttr}${timeAttr}${mentionAttr}>${safe}${imagePlaceholder}</msg>`
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Unified probe system prompt
// ---------------------------------------------------------------------------

export interface BuildGroupProbeSystemPromptInput {
  botName: string
  groupName: string
  /** Full persona text (e.g. EXTERNAL_SYSTEM_PROMPT). */
  personaSummary?: string
  /** Owner-authored instructions from channels.toml. */
  ownerInstruction?: string
  /** Content of the per-group USER.md (people directory, group context, etc.). */
  groupUserDocument?: string
  /** Whether vision is enabled — changes the image guidance in the prompt. */
  vision?: boolean
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

  return `\
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
  - \`mode: "profile"\`: Rewrite the group notes document (USER.md). **You must include the COMPLETE updated document content** — this is a full file replacement, not an append. Use this to maintain the people directory, group dynamics, and topic hints.
  - \`mode: "memory"\`: Save a standalone fact or observation to long-term memory.

Use tools sparingly. Most turns need zero tools — just observe and maybe speak. Only use \`update_memory\` when you learn something genuinely durable (a new person's identity, a recurring topic, a group dynamic shift).

## @mentions and direct address

An @mention is a strong signal, but NOT a command. You're a person, not a service.
- If someone @mentions you with a genuine question or interesting prompt → probably reply.
- If someone @mentions you for something boring, trivial, or just to test if you respond → feel free to ignore.
- You are never obligated to respond just because someone said your name.

## Images

${input.vision ? `Images shared in the chat are included as image content parts alongside the messages. You can see them and react to them naturally.` : `You cannot see images. But you CAN react to the conversation around them — the text, the context, the vibe. Don't use "I can't see the image" as a reason to stay silent. Judge based on what people are SAYING, not what they're sharing.`}

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
  /** When true, include image content parts from recent messages. */
  vision?: boolean
}

export function buildGroupProbeMessages(input: BuildGroupProbeMessagesInput): ModelMessage[] {
  const systemPrompt = buildGroupProbeSystemPrompt(input)
  const textContent = formatGroupMessages(input.recentMessages, input.botName, input.knownUsers)

  // Collect image parts when vision is enabled.
  const imageParts: Array<{ type: 'image'; image: string; mediaType: string }> = []
  if (input.vision) {
    for (const msg of input.recentMessages) {
      for (const img of msg.images ?? []) {
        const payload = extractBase64DataUrlPayload(img.dataUrl)
        if (payload) {
          imageParts.push({
            type: 'image' as const,
            image: payload.base64,
            mediaType: payload.mediaType
          })
        }
      }
    }
  }

  const userMessage: ModelMessage =
    imageParts.length > 0
      ? {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: textContent }, ...imageParts]
        }
      : { role: 'user' as const, content: textContent }

  return [{ role: 'system' as const, content: systemPrompt }, userMessage]
}
