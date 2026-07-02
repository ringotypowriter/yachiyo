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
