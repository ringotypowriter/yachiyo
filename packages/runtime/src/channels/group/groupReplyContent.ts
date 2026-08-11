const INVISIBLE_GROUP_REPLY_CHARS_RE = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g

/**
 * Preserve the model's visible message exactly as written. Only content that
 * would render as an empty message is rejected at the delivery boundary.
 */
export function prepareGroupReplyForDelivery(message: string): string | null {
  return message.replace(INVISIBLE_GROUP_REPLY_CHARS_RE, '').trim().length > 0 ? message : null
}
