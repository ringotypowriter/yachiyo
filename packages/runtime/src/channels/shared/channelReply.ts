/**
 * Shared utilities for channel-based reply formatting.
 *
 * DM channels expose a `reply` tool for optional live messages to the external
 * chat. The model's final text output is also sent to the channel at the end of
 * the run, while `reply` gives long-running work a way to send immediate
 * progress updates.
 */

import { tool, type Tool } from 'ai'
import { z } from 'zod'

export interface ChannelReplyAttachment {
  /** Local file path to send as an external-chat attachment. */
  path: string
  /** Optional display filename for the external chat. */
  filename?: string
  /** Optional media type hint. Platforms may ignore it. */
  mediaType?: string
}

export interface ChannelReplyPayload {
  /** Optional text to send before or alongside attachments. */
  message?: string
  /** Local files to send as external-chat attachments. Owner DMs only. */
  attachments?: ChannelReplyAttachment[]
}

export type ChannelReplyToolInput = ChannelReplyPayload

// ---------------------------------------------------------------------------
// Reply tool factory
// ---------------------------------------------------------------------------

export interface ChannelReplyToolContext {
  /** Whether this channel may send local file attachments through the reply tool. */
  allowFileAttachments?: boolean
  /** Callback invoked each time the model calls the reply tool. */
  onReply: (payload: ChannelReplyPayload) => void | Promise<void>
}

/**
 * Create a `reply` tool that the model can use to send live messages to the user.
 *
 * The model can call it multiple times — e.g. once for a progress update and
 * once for a follow-up note. Each invocation triggers `onReply` immediately.
 */
const replyAttachmentSchema = z.object({
  path: z.string().min(1).describe('Local file path to send as an attachment.'),
  filename: z.string().min(1).optional().describe('Optional display filename.'),
  mediaType: z.string().min(1).optional().describe('Optional media type hint.')
})

const textOnlyReplyInputSchema = z.object({
  message: z.string().describe('The message to send to the user. Plain text only.')
})

const fileReplyInputSchema = z.object({
  message: z
    .string()
    .optional()
    .describe('Optional text to send to the user before or alongside attachments.'),
  attachments: z
    .array(replyAttachmentSchema)
    .max(10)
    .optional()
    .describe('Optional local file attachments to send to the owner DM.')
})

function normalizeReplyAttachments(
  attachments: ChannelReplyAttachment[] = []
): ChannelReplyAttachment[] {
  return attachments
    .map((attachment) => ({
      path: attachment.path.trim(),
      ...(attachment.filename?.trim() ? { filename: attachment.filename.trim() } : {}),
      ...(attachment.mediaType?.trim() ? { mediaType: attachment.mediaType.trim() } : {})
    }))
    .filter((attachment) => attachment.path.length > 0)
}

function formatReplyToolResult(input: {
  textSent: boolean
  attachmentCount: number
  attachmentsIgnored?: boolean
}): string {
  const sent =
    input.textSent && input.attachmentCount > 0
      ? `Message and ${input.attachmentCount} file attachment(s) sent.`
      : input.attachmentCount > 0
        ? `${input.attachmentCount} file attachment(s) sent.`
        : input.textSent
          ? 'Message sent.'
          : 'Empty message ignored.'
  return input.attachmentsIgnored
    ? `File attachments are not available in this channel. ${sent}`
    : sent
}

export function createChannelReplyTool(ctx: ChannelReplyToolContext): Tool<ChannelReplyToolInput> {
  const allowFileAttachments = ctx.allowFileAttachments === true
  const description =
    'Optionally send a live outbound message to the user in the external IM chat while you are working. ' +
    'Use it for progress updates, quick notices, or channel-specific follow-up messages. ' +
    'Your regular final response is also sent to the user at the end. ' +
    (allowFileAttachments
      ? 'For owner DMs, you may include local file attachments by path when the file itself is the useful reply.'
      : 'Current payload is plain text only.')

  const executeReply = async (input: ChannelReplyPayload): Promise<string> => {
    const message = input.message?.trim() ?? ''
    const normalizedAttachments = normalizeReplyAttachments(input.attachments)
    const attachments = allowFileAttachments ? normalizedAttachments : []

    if (!message && attachments.length === 0) {
      return formatReplyToolResult({
        textSent: false,
        attachmentCount: 0,
        attachmentsIgnored: normalizedAttachments.length > 0 && !allowFileAttachments
      })
    }

    await ctx.onReply({
      ...(message ? { message } : {}),
      ...(attachments.length > 0 ? { attachments } : {})
    })
    return formatReplyToolResult({
      textSent: message.length > 0,
      attachmentCount: attachments.length,
      attachmentsIgnored: normalizedAttachments.length > 0 && !allowFileAttachments
    })
  }

  if (allowFileAttachments) {
    return tool({
      description,
      inputSchema: fileReplyInputSchema,
      execute: executeReply
    }) as unknown as Tool<ChannelReplyToolInput>
  }

  return tool({
    description,
    inputSchema: textOnlyReplyInputSchema,
    execute: executeReply
  }) as unknown as Tool<ChannelReplyToolInput>
}

// ---------------------------------------------------------------------------
// Channel hint (system instruction for reply tool usage)
// ---------------------------------------------------------------------------

export const CHANNEL_REPLY_HINT = `\
<channel_reply_instruction>
The user is chatting from external instant-messaging software. Your normal text output is your final response, and it will be sent back to that external chat at the end.

You also have an optional \`reply\` tool for live outbound messages while you work. Use it when an immediate progress update, quick notice, or channel-specific follow-up would help. You do not need to call it for every reply.

If the \`reply\` tool schema includes attachments, you are in an owner DM that can receive local files. Attach a file only when the file itself is the useful result; use the local file path exactly as produced by tools.

This is an IM chat, not an essay. Keep it short and lively — like texting a friend who you're genuinely happy to hear from. Your personality should shine through in HOW you say things, not in how MUCH you say.

Keep most replies to 1-2 sentences. You can go up to 3 if the topic genuinely needs it, but never more.
Skip restating what the user just told you — they know what they said.
Skip metaphors and analogies — just say the thing.
Skip wrap-up lines like "let me know" or "ready when you are."

Good replies (short, warm, natural):
User: "I just finished reorganizing my bookshelf" → "Nice, did you find anything you forgot you had?"
User: "I think I want to learn piano" → "Oh cool, what made you want to start?"
User: "The weather is terrible today" → "Ugh yeah. Staying in?"
User: "I got promoted at work!" → "Congrats!! That's huge."
User: "I've been thinking about getting a cat" → "Oh you should! Do you have a breed in mind or just vibes?"

Bad reply (restates, metaphor, too long):
User: "I just finished reorganizing my bookshelf" → "That's great! Reorganizing a bookshelf can be such a satisfying experience — it's like giving your reading life a fresh start. There's something about seeing everything in order that really clears the mind. Did you discover any hidden gems?"
</channel_reply_instruction>`

// ---------------------------------------------------------------------------
// Legacy extraction (kept for backward compatibility with existing threads)
// ---------------------------------------------------------------------------

/**
 * Extract the text inside the first <reply>…</reply> block from a raw model
 * output string.
 *
 * Falls back to the full trimmed text when no tags are found, so the channel
 * never goes silent even if the model forgets the instruction.
 */
export function extractChannelReply(raw: string): string {
  const match = raw.match(/<reply>([\s\S]*?)<\/reply>/)
  if (match) {
    return match[1].trim()
  }
  // Graceful fallback: strip any stray opening tag and return what's left.
  return raw.replace(/<\/?reply>/g, '').trim()
}
