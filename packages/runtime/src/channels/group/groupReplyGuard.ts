const INVISIBLE_GROUP_REPLY_CHARS_RE = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g

/**
 * Hard ceiling for a single group chat message, in code points. One or two
 * short chat sentences fit; assistant-style essays don't. Prompts can only ask
 * for brevity — this gate enforces it mechanically regardless of model.
 */
export const GROUP_REPLY_MAX_CHARS = 60

export function isOverlongGroupReply(message: string): boolean {
  return [...message.trim()].length > GROUP_REPLY_MAX_CHARS
}

export function hasForbiddenGroupReplyPrefix(message: string): boolean {
  return /^\s*[:：}]/.test(message)
}

export function hasVisibleGroupReplyContent(message: string): boolean {
  return message.replace(INVISIBLE_GROUP_REPLY_CHARS_RE, '').trim().length > 0
}

// Style gate: mechanical rejections for the observable signatures of the
// assistant register. Only hard, countable patterns live here — abstract
// personality rules stay in the prompt, where they belong.

/** Agreement/advice lead-ins that mark an assistant answering, not a friend chatting. */
const ASSISTANT_TONE_OPENER_RE = /^\s*(对|是的|确实|没错|可以考虑)\s*[，,]/

/** The quoted-simile commentary gimmick ("这就像 XX" framings). */
const TEMPLATE_PHRASES = ['这就像', '这就很像', '这张像是', '这图很像'] as const

/** More clause separators than this reads as structured prose, not chat. */
export const GROUP_REPLY_MAX_CLAUSE_SEPARATORS = 2

function countClauseSeparators(message: string): number {
  return (message.match(/[，,；;]/g) ?? []).length
}

/**
 * Returns an instructive rejection reason when the message carries an
 * assistant-register signature, or null when it reads like chat. Callers feed
 * the reason back to the model so it resends in plain chat voice.
 */
export function findGroupReplyStyleIssue(message: string): string | null {
  if (ASSISTANT_TONE_OPENER_RE.test(message)) {
    return 'starts with an agreement filler (对，/是的，/确实，…). Drop the filler and say the actual point directly.'
  }
  const template = TEMPLATE_PHRASES.find((phrase) => message.includes(phrase))
  if (template) {
    return `uses the "${template}" commentary formula. React to the thing itself instead of framing a simile about it.`
  }
  if (countClauseSeparators(message) > GROUP_REPLY_MAX_CLAUSE_SEPARATORS) {
    return 'has too many clauses — that is structured prose, not chat. Make one point in at most two short sentences.'
  }
  return null
}
