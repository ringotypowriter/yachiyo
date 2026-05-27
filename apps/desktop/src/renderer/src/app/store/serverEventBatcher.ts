import type { MessageDeltaEvent, MessageReasoningDeltaEvent } from '@yachiyo/shared/protocol'
import type { YachiyoServerEvent } from '../types.ts'

type StreamDeltaEvent = MessageDeltaEvent | MessageReasoningDeltaEvent

interface PendingDeltaBatch {
  event: StreamDeltaEvent
  delta: string
}

interface ServerEventBatcherOptions {
  applyEvent: (event: YachiyoServerEvent) => void
  scheduleFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
}

export interface ServerEventBatcher {
  push: (event: YachiyoServerEvent) => void
  flush: () => void
  dispose: () => void
}

export function createServerEventBatcher(options: ServerEventBatcherOptions): ServerEventBatcher {
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame
  const pendingBatches: PendingDeltaBatch[] = []
  let scheduledFrameId: number | null = null

  const cancelScheduledFrame = (): void => {
    if (scheduledFrameId === null) return
    cancelFrame(scheduledFrameId)
    scheduledFrameId = null
  }

  const flush = (): void => {
    cancelScheduledFrame()
    if (pendingBatches.length === 0) return

    const batches = pendingBatches.splice(0)
    for (const batch of batches) {
      options.applyEvent({ ...batch.event, delta: batch.delta })
    }
  }

  const scheduleFlush = (): void => {
    if (scheduledFrameId !== null) return
    scheduledFrameId = scheduleFrame(() => {
      scheduledFrameId = null
      flush()
    })
  }

  const pushDelta = (event: StreamDeltaEvent): void => {
    const previous = pendingBatches.at(-1)
    if (previous && canMergeDeltaEvents(previous.event, event)) {
      previous.delta += event.delta
    } else {
      pendingBatches.push({ event, delta: event.delta })
    }
    scheduleFlush()
  }

  return {
    push(event) {
      if (isStreamDeltaEvent(event)) {
        pushDelta(event)
        return
      }

      flush()
      options.applyEvent(event)
    },
    flush,
    dispose() {
      cancelScheduledFrame()
      pendingBatches.length = 0
    }
  }
}

function isStreamDeltaEvent(event: YachiyoServerEvent): event is StreamDeltaEvent {
  return event.type === 'message.delta' || event.type === 'message.reasoning.delta'
}

function canMergeDeltaEvents(left: StreamDeltaEvent, right: StreamDeltaEvent): boolean {
  return (
    left.type === right.type &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.messageId === right.messageId
  )
}

function defaultScheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback)
  }

  return window.setTimeout(callback, 16)
}

function defaultCancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id)
    return
  }

  window.clearTimeout(id)
}
