const INVISIBLE_GROUP_REPLY_CHARS_RE = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g

export function hasForbiddenGroupReplyPrefix(message: string): boolean {
  return /^\s*[:：}]/.test(message)
}

export function hasVisibleGroupReplyContent(message: string): boolean {
  return message.replace(INVISIBLE_GROUP_REPLY_CHARS_RE, '').trim().length > 0
}
