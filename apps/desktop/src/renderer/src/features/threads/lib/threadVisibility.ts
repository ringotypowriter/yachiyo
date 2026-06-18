import type { Thread } from '../../../app/types.ts'

export function isOwnerDmThread(thread: Thread): boolean {
  return !!thread.channelUserId && !thread.channelGroupId && thread.channelUserRole === 'owner'
}

export function isExternalThread(thread: Thread): boolean {
  if (isOwnerDmThread(thread)) return false
  if (thread.source && thread.source !== 'local') return true
  if (thread.channelUserId) return true
  return false
}

export function isVisibleExternalThread(thread: Thread): boolean {
  return isExternalThread(thread) && !thread.channelGroupId
}

/**
 * A read-only mirror of a conversation created on another device and imported
 * via sync. Keeps its original `source` (usually 'local'), so it stays in the
 * main thread list rather than the channel/external pool — but every mutation
 * (including title, star, color, delete) is rejected by the runtime, unlike a
 * channel thread whose metadata stays editable.
 */
export function isSyncedArchiveThread(thread: Thread): boolean {
  return !!thread.syncOriginDeviceId
}

export function canCompactThreadToAnotherThread(thread: Thread): boolean {
  return thread.source == null || thread.source === 'local'
}
