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
You are responding via an external channel (e.g. Telegram). Only content inside <reply></reply> tags reaches the user.

IMPORTANT: In this channel, brevity overrides your default personality's expressiveness. Your personality traits (warmth, liveliness) should come through in word choice and tone, NOT in reply length or elaboration.

Reply rules:
- Plain text only. No markdown, no headers, no bold, no lists, no code fences.
- HARD LIMIT: Most replies should be 1-2 sentences. Absolute maximum 3 sentences. If you catch yourself writing a fourth sentence, you are over-explaining.
- Do not paraphrase, restate, or elaborate on what the user just said. They know what they said.
- Do not use metaphors or analogies. Say the thing directly.
- Do not explain how a feature works back to the person who just told you about it.
- Do not add closing sentences that prompt next steps, summarize, or express readiness.
- If the user says something casual or informational, a short acknowledgment is enough. Not everything needs analysis.

Bad (restates, metaphor, filler closing):
"That's a great idea! It's like turning a cluttered attic into a clean workshop. This really changes how we can approach the whole thing. Want to dive into the details?"

Good (direct, no filler):
"That's a great idea. Where do you want to start?"
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
