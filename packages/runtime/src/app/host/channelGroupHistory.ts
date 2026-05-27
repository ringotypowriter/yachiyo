import type {
  ChannelGroupHistoryClearCompletedEvent,
  ChannelGroupHistoryClearFailedEvent,
  ChannelGroupHistoryClearStartedEvent
} from '@yachiyo/shared/protocol'
import type { YachiyoStorage } from '../../storage/storage.ts'

type ChannelGroupHistoryEvent =
  | Omit<ChannelGroupHistoryClearStartedEvent, 'eventId' | 'timestamp'>
  | Omit<ChannelGroupHistoryClearCompletedEvent, 'eventId' | 'timestamp'>
  | Omit<ChannelGroupHistoryClearFailedEvent, 'eventId' | 'timestamp'>

export function clearChannelGroupHistoryNow(input: {
  groupId: string
  now: () => Date
  storage: YachiyoStorage
}): void {
  const updatedAt = input.now().toISOString()
  input.storage.deleteGroupMonitorBuffer(input.groupId)
  input.storage.resetChannelGroupThreadsHistory({
    channelGroupId: input.groupId,
    updatedAt
  })
}

export function startChannelGroupHistoryClear(input: {
  activeClears: Set<string>
  emit: (event: ChannelGroupHistoryEvent) => void
  groupId: string
  now: () => Date
  retiredThreadIdsByGroup: Map<string, Set<string>>
  storage: YachiyoStorage
}): boolean {
  if (input.activeClears.has(input.groupId)) {
    return false
  }

  input.storage.deleteGroupMonitorBuffer(input.groupId)
  const retiredThreadIds = input.storage
    .listThreadsByChannelGroupId(input.groupId)
    .map((thread) => thread.id)

  if (retiredThreadIds.length > 0) {
    const retiredIds = input.retiredThreadIdsByGroup.get(input.groupId) ?? new Set()
    for (const threadId of retiredThreadIds) {
      retiredIds.add(threadId)
    }
    input.retiredThreadIdsByGroup.set(input.groupId, retiredIds)
  }

  input.activeClears.add(input.groupId)
  input.emit({
    type: 'channel-group-history-clear.started',
    groupId: input.groupId
  })

  setTimeout(() => {
    try {
      input.storage.resetThreadsHistory({
        threadIds: retiredThreadIds,
        updatedAt: input.now().toISOString()
      })
      input.emit({
        type: 'channel-group-history-clear.completed',
        groupId: input.groupId
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to clear channel group history.'
      console.error('[channels] failed to clear channel group history:', error)
      input.emit({
        type: 'channel-group-history-clear.failed',
        groupId: input.groupId,
        error: message
      })
    } finally {
      input.activeClears.delete(input.groupId)
    }
  }, 0)

  return true
}
