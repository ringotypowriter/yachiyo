import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'

export type YachiyoServerEventPayload<TEvent extends YachiyoServerEvent = YachiyoServerEvent> =
  TEvent extends YachiyoServerEvent ? Omit<TEvent, 'eventId' | 'timestamp'> : never

export function projectVisibleRunEvent(input: {
  event: YachiyoServerEventPayload
  runDomain: YachiyoServerRunDomain
}): YachiyoServerEventPayload {
  const { event, runDomain } = input
  if (event.type === 'thread.state.replaced') {
    const snapshot = runDomain.withQueuedFollowUpDraftSnapshot({
      thread: event.thread,
      messages: event.messages,
      queuedFollowUpMessages: event.queuedFollowUpMessages,
      toolCalls: event.toolCalls
    })
    return {
      ...event,
      thread: snapshot.thread,
      messages: snapshot.messages,
      queuedFollowUpMessages: snapshot.queuedFollowUpMessages,
      toolCalls: snapshot.toolCalls
    }
  }

  return event
}
