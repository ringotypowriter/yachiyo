import type { MessageRecord } from '@yachiyo/shared/protocol'

export interface MessagePageOptions {
  limit?: number
  beforeMessageId?: string
}

/**
 * Select the page of a thread to hand back, walking backwards from the newest
 * message.
 *
 * Lives here rather than inside the sqlite reader because that file's tests
 * only run where the native module matches the host Node — which is to say,
 * almost never. Keeping the decision in plain code means it is actually
 * covered rather than merely accompanied by a test file.
 *
 * The window is anchored at the new end, but the page is returned in reading
 * order: callers render a conversation, not a reversed list.
 */
export function pageMessageWindow(
  messages: MessageRecord[],
  options?: MessagePageOptions
): MessageRecord[] {
  if (options?.limit === undefined) return messages

  if (options.beforeMessageId === undefined) {
    return messages.slice(Math.max(0, messages.length - options.limit))
  }

  const cursorIndex = messages.findIndex((message) => message.id === options.beforeMessageId)
  // An unknown cursor must not fall back to "the newest page". That would
  // hand back the same messages every time while the caller believed it was
  // walking backwards — an infinite scroll that never moves.
  if (cursorIndex < 0) return []

  return messages.slice(Math.max(0, cursorIndex - options.limit), cursorIndex)
}
