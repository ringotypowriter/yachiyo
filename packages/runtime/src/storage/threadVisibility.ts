import type { ChannelUserRole } from '@yachiyo/shared/protocol'

/**
 * Threads the owner's own surfaces may list: local threads, and DM threads with an owner channel
 * user outside any group. Guest and group channel threads stay private to their channels.
 * Accepts both stored rows (`null`) and records (`undefined`).
 */
export function isLocalOrOwnerDmThread(
  thread: {
    source?: string | null
    channelUserId?: string | null
    channelGroupId?: string | null
  },
  channelUserRole: ChannelUserRole | null | undefined
): boolean {
  if ((thread.source == null || thread.source === 'local') && thread.channelUserId == null) {
    return true
  }
  return (
    thread.channelGroupId == null && thread.channelUserId != null && channelUserRole === 'owner'
  )
}
