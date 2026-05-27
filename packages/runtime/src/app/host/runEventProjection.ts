import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'

export type YachiyoServerEventPayload<TEvent extends YachiyoServerEvent = YachiyoServerEvent> =
  TEvent extends YachiyoServerEvent ? Omit<TEvent, 'eventId' | 'timestamp'> : never

export function projectVisibleRunEvent(input: {
  event: YachiyoServerEventPayload
  runDomain: YachiyoServerRunDomain
}): YachiyoServerEventPayload {
  const { event, runDomain } = input
  if (event.type === 'thread.updated') {
    return {
      ...event,
      thread: runDomain.withQueuedFollowUpDraft(event.thread)
    }
  }

  if (event.type === 'thread.state.replaced') {
    const snapshot = runDomain.withQueuedFollowUpDraftSnapshot({
      thread: event.thread,
      messages: event.messages,
      toolCalls: event.toolCalls
    })
    return {
      ...event,
      thread: snapshot.thread,
      messages: snapshot.messages,
      toolCalls: snapshot.toolCalls
    }
  }

  return event
}
