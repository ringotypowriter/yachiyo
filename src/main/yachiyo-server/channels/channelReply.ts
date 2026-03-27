/**
 * Shared utilities for channel-based reply formatting.
 *
 * The model is instructed to wrap its outgoing reply in <reply></reply> tags.
 * Only the content inside those tags reaches the end user; everything outside
 * is discarded.  This lets the model think, plan, or use tools privately while
 * sending a clean, natural-sounding message to the channel.
 */

export const CHANNEL_REPLY_HINT = `\
<channel_reply_instruction>
You are responding to a message delivered via an external channel (e.g. Telegram).
The channel user can only see what you put inside <reply></reply> tags — nothing else reaches them.
Keep the reply short, warm, and natural — like texting a friend, not writing an email.
No markdown formatting unless it genuinely adds value.
</channel_reply_instruction>`

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
