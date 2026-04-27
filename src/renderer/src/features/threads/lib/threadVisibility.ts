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

export function canCompactThreadToAnotherThread(thread: Thread): boolean {
  return thread.source == null || thread.source === 'local'
}
