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

This is a chat, not an essay. Keep it short and lively — like texting a friend who you're genuinely happy to hear from. Your personality should shine through in HOW you say things, not in how MUCH you say.

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
