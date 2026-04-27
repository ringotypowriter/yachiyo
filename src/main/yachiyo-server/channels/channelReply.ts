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

// ---------------------------------------------------------------------------
// Reply tool factory
// ---------------------------------------------------------------------------

export interface ChannelReplyToolContext {
  /** Callback invoked each time the model calls the reply tool. */
  onReply: (message: string) => void | Promise<void>
}

/**
 * Create a `reply` tool that the model can use to send live messages to the user.
 *
 * The model can call it multiple times — e.g. once for a progress update and
 * once for a follow-up note. Each invocation triggers `onReply` immediately.
 */
export function createChannelReplyTool(ctx: ChannelReplyToolContext): Tool<{ message: string }> {
  return tool({
    description:
      'Optionally send a live outbound message to the user in the external IM chat while you are working. ' +
      'Use it for progress updates, quick notices, or channel-specific follow-up messages. ' +
      'Your regular final response is also sent to the user at the end. Current payload is plain text only.',
    inputSchema: z.object({
      message: z.string().describe('The message to send to the user. Plain text only.')
    }),
    execute: async ({ message }) => {
      const trimmed = message.trim()
      if (!trimmed) {
        return 'Empty message ignored.'
      }
      await ctx.onReply(trimmed)
      return 'Message sent.'
    }
  })
}

// ---------------------------------------------------------------------------
// Channel hint (system instruction for reply tool usage)
// ---------------------------------------------------------------------------

export const CHANNEL_REPLY_HINT = `\
<channel_reply_instruction>
The user is chatting from external instant-messaging software. Your normal text output is your final response, and it will be sent back to that external chat at the end.

You also have an optional \`reply\` tool for live outbound messages while you work. Use it when an immediate progress update, quick notice, or channel-specific follow-up would help. You do not need to call it for every reply.

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
