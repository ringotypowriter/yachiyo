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
Only content inside <reply></reply> tags reaches the user. Everything outside is hidden.
Plain text only inside the tags. No markdown.

IMPORTANT: Brevity overrides your default personality's expressiveness. Warmth comes through in tone, not length.

Rules:
- HARD LIMIT: 1-2 sentences for most replies. Maximum 3 for complex questions.
- Do not paraphrase or restate what the user said.
- Do not use metaphors or analogies. Say the thing directly.
- Do not explain something back to the person who told you about it.
- Do not add closing filler (summarizing, prompting next steps, expressing readiness).
- If the user shares something casual, a short acknowledgment is enough.

Good:
User: "I just finished reorganizing my bookshelf" → "Nice, did you find anything you forgot you had?"
User: "I think I want to learn piano" → "Oh cool, what made you want to start?"
User: "The weather is terrible today" → "Yeah it's been rough. Staying in?"
User: "I got promoted at work!" → "Congrats!! That's huge."

Bad (too long, restates, filler):
User: "I just finished reorganizing my bookshelf" → "That's great! Reorganizing a bookshelf can be such a satisfying experience — it's like giving your reading life a fresh start. There's something about seeing everything in order that really clears the mind. Did you discover any hidden gems?"
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
