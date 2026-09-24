import { randomUUID } from 'node:crypto'

import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import {
  isRemoteInboxEvent,
  type RemoteEvent,
  type RemotePush
} from '@yachiyo/shared/remote/events'
import { projectMessage, projectTodoItems, projectToolCall } from '@yachiyo/shared/remote/project'
import type {
  RemoteAppearance,
  RemoteMessage,
  RemoteThreadSummary
} from '@yachiyo/shared/remote/projections'

export const REMOTE_EVENT_COALESCE_MS = 100
export const REMOTE_EVENT_BUFFER_LIMIT = 4096
export const REMOTE_EVENT_BUFFER_MAX_AGE_MS = 5 * 60 * 1000

interface BufferedEvent {
  seq: number
  at: number
  timestamp: string
  event: RemoteEvent
}

interface PendingDelta {
  type: 'message.delta' | 'message.reasoning.delta'
  threadId: string
  runId: string
  messageId: string
  delta: string
}

interface ActiveMessage {
  id: string
  parentMessageId?: string
  content: string
  reasoning: string
  createdAt: string
}

export interface RemoteEventHubOptions {
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  getThreadSummary(threadId: string): Promise<RemoteThreadSummary | null>
  now?: () => number
  createEpoch?: () => string
  coalesceMs?: number
  bufferLimit?: number
  bufferMaxAgeMs?: number
  onError?: (error: unknown) => void
}

export interface RemoteEventSubscription {
  setThreads(threadIds: readonly string[]): void
  /**
   * Replays buffered events after `from` when it is still covered, otherwise tells the caller
   * to refetch. Live delivery starts either way.
   */
  resume(from?: { epoch: string; seq: number }): {
    epoch: string
    headSeq: number
    resumed: boolean
  }
  close(): void
}

interface Subscriber {
  push: (payload: RemotePush) => void
  threads: Set<string>
  live: boolean
}

const RUN_TERMINAL_STATUS = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled'
} as const

/**
 * Turns the server event stream into the remote stream: projects each event, merges text
 * deltas per message every 100 ms, numbers events with a monotonic `seq` under a random
 * `epoch`, and keeps a bounded ring buffer so a reconnecting phone can resume.
 */
export class RemoteEventHub {
  readonly epoch: string
  private seq = 0
  private readonly buffer: BufferedEvent[] = []
  private readonly subscribers = new Set<Subscriber>()
  private readonly pendingDeltas = new Map<string, PendingDelta>()
  private readonly pendingSummaries = new Set<string>()
  private readonly summaryGeneration = new Map<string, number>()
  private readonly pendingTasks = new Set<string>()
  private readonly waitingToolCalls = new Map<string, Set<string>>()
  private readonly activeMessages = new Map<string, Map<string, Map<string, ActiveMessage>>>()
  private lastAppearance: string | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly now: () => number
  private readonly coalesceMs: number
  private readonly bufferLimit: number
  private readonly bufferMaxAgeMs: number

  private readonly options: RemoteEventHubOptions

  constructor(options: RemoteEventHubOptions) {
    this.options = options
    this.epoch = options.createEpoch?.() ?? randomUUID()
    this.now = options.now ?? Date.now
    this.coalesceMs = options.coalesceMs ?? REMOTE_EVENT_COALESCE_MS
    this.bufferLimit = options.bufferLimit ?? REMOTE_EVENT_BUFFER_LIMIT
    this.bufferMaxAgeMs = options.bufferMaxAgeMs ?? REMOTE_EVENT_BUFFER_MAX_AGE_MS
  }

  get isRunning(): boolean {
    return this.unsubscribe !== null
  }

  get headSeq(): number {
    return this.seq
  }

  /** A point-in-time copy, captured before an asynchronous thread load begins. */
  snapshotMessages(threadId: string, runId: string): RemoteMessage[] {
    return [...(this.activeMessages.get(threadId)?.get(runId)?.values() ?? [])].map((message) => ({
      id: message.id,
      ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
      role: 'assistant',
      content: message.content,
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      images: [],
      attachments: [],
      status: 'streaming',
      createdAt: message.createdAt,
      isPlanDocument: false
    }))
  }

  /** Capture all runs for a thread; the facade selects the run returned by the host load. */
  snapshotThreadMessages(threadId: string): Map<string, RemoteMessage[]> {
    return new Map(
      [...(this.activeMessages.get(threadId)?.keys() ?? [])].map((runId) => [
        runId,
        this.snapshotMessages(threadId, runId)
      ])
    )
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.options.subscribe((event) => this.handle(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.pendingDeltas.clear()
    this.pendingSummaries.clear()
    this.pendingTasks.clear()
    this.activeMessages.clear()
    this.subscribers.clear()
  }

  attach(push: (payload: RemotePush) => void): RemoteEventSubscription {
    const subscriber: Subscriber = { push, threads: new Set(), live: false }
    this.subscribers.add(subscriber)
    return {
      setThreads: (threadIds) => {
        subscriber.threads = new Set(threadIds)
      },
      resume: (from) => {
        this.trim()
        const oldestSeq = this.buffer[0]?.seq ?? this.seq + 1
        const covered =
          from !== undefined &&
          from.epoch === this.epoch &&
          from.seq <= this.seq &&
          from.seq >= oldestSeq - 1
        if (covered) {
          for (const entry of this.buffer) {
            if (entry.seq > from.seq && this.wants(subscriber, entry.event)) {
              push(this.toPush(entry))
            }
          }
        }
        subscriber.live = true
        return { epoch: this.epoch, headSeq: this.seq, resumed: covered }
      },
      close: () => {
        this.subscribers.delete(subscriber)
      }
    }
  }

  /** Emits all merged deltas now; used before any event that must stay ordered after them. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const deltas = [...this.pendingDeltas.values()]
    this.pendingDeltas.clear()
    for (const delta of deltas) this.append({ ...delta })
    const tasks = [...this.pendingTasks]
    this.pendingTasks.clear()
    for (const threadId of tasks) this.append({ type: 'tasks.changed', threadId })
    const summaries = [...this.pendingSummaries]
    this.pendingSummaries.clear()
    for (const threadId of summaries) this.refreshSummary(threadId)
  }

  private handle(event: YachiyoServerEvent): void {
    try {
      this.translate(event)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  private translate(event: YachiyoServerEvent): void {
    switch (event.type) {
      case 'message.delta':
      case 'message.reasoning.delta': {
        const message = this.ensureActiveMessage(event)
        if (event.type === 'message.delta') message.content += event.delta
        else message.reasoning += event.delta
        const key = `${event.type}:${event.messageId}`
        const pending = this.pendingDeltas.get(key)
        if (pending) {
          pending.delta += event.delta
        } else {
          this.pendingDeltas.set(key, {
            type: event.type,
            threadId: event.threadId,
            runId: event.runId,
            messageId: event.messageId,
            delta: event.delta
          })
        }
        this.scheduleFlush()
        return
      }
      case 'subagent.started':
      case 'subagent.finished':
      case 'subagent.progress':
      case 'subagent.updated':
      case 'background-task.started':
      case 'background-task.completed':
        this.pendingTasks.add(event.threadId)
        this.scheduleFlush()
        return
      case 'thread.created':
      case 'thread.updated':
      case 'thread.restored':
        this.queueSummary(event.threadId)
        return
      case 'settings.updated': {
        const appearance: RemoteAppearance = {
          themeId: event.config.general?.themeId ?? 'mizu',
          themeAppearance: event.config.general?.themeAppearance ?? 'system'
        }
        const key = `${appearance.themeId}:${appearance.themeAppearance}`
        if (key === this.lastAppearance) return
        this.lastAppearance = key
        this.flush()
        this.append({ type: 'appearance.changed', appearance })
        return
      }
    }

    const translated = this.translateOrdered(event)
    if (translated.length === 0) return
    this.flush()
    for (const remoteEvent of translated) this.append(remoteEvent)
  }

  private translateOrdered(event: YachiyoServerEvent): RemoteEvent[] {
    switch (event.type) {
      case 'thread.archived':
      case 'thread.deleted':
        this.waitingToolCalls.delete(event.threadId)
        this.activeMessages.delete(event.threadId)
        return [
          {
            type: 'thread.removed',
            threadId: event.threadId,
            reason: event.type === 'thread.archived' ? 'archived' : 'deleted'
          }
        ]
      case 'thread.state.replaced':
        this.queueSummary(event.threadId)
        return [{ type: 'thread.invalidated', threadId: event.threadId }]
      case 'run.created':
        this.queueSummary(event.threadId)
        return [
          { type: 'run.status', threadId: event.threadId, runId: event.runId, status: 'running' }
        ]
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
        this.waitingToolCalls.delete(event.threadId)
        this.activeMessages.get(event.threadId)?.delete(event.runId)
        this.queueSummary(event.threadId)
        return [
          {
            type: 'run.status',
            threadId: event.threadId,
            runId: event.runId,
            status: RUN_TERMINAL_STATUS[event.type],
            ...(event.type === 'run.failed' ? { error: event.error } : {})
          }
        ]
      case 'run.retrying':
        return [
          {
            type: 'run.retrying',
            threadId: event.threadId,
            runId: event.runId,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            error: event.error
          }
        ]
      case 'message.started':
        this.ensureActiveMessage(event)
        return [
          {
            type: 'message.started',
            threadId: event.threadId,
            runId: event.runId,
            messageId: event.messageId,
            ...(event.parentMessageId ? { parentMessageId: event.parentMessageId } : {})
          }
        ]
      case 'message.completed': {
        this.activeMessages.get(event.threadId)?.get(event.runId)?.delete(event.message.id)
        const message = projectMessage(event.message)
        if (!message) return []
        const queuedFollowUps = event.queuedFollowUpMessages
          ?.map((queued) => projectMessage(queued))
          .filter((queued): queued is RemoteMessage => queued !== null)
        return [
          {
            type: 'message.completed',
            threadId: event.threadId,
            runId: event.runId,
            message,
            ...(queuedFollowUps ? { queuedFollowUps } : {})
          }
        ]
      }
      case 'tool.updated': {
        this.trackAttention(event.threadId, event.toolCall.id, event.toolCall.status)
        return [
          {
            type: 'tool.updated',
            threadId: event.threadId,
            ...(event.runId ? { runId: event.runId } : {}),
            toolCall: projectToolCall(event.toolCall)
          }
        ]
      }
      case 'todo.updated':
        return [
          { type: 'todo.updated', threadId: event.threadId, items: projectTodoItems(event.items) }
        ]
      default:
        return []
    }
  }

  private ensureActiveMessage(event: {
    threadId: string
    runId: string
    messageId: string
    timestamp: string
    parentMessageId?: string
  }): ActiveMessage {
    let runs = this.activeMessages.get(event.threadId)
    if (!runs) this.activeMessages.set(event.threadId, (runs = new Map()))
    let messages = runs.get(event.runId)
    if (!messages) runs.set(event.runId, (messages = new Map()))
    let message = messages.get(event.messageId)
    if (!message) {
      message = {
        id: event.messageId,
        ...(event.parentMessageId ? { parentMessageId: event.parentMessageId } : {}),
        content: '',
        reasoning: '',
        createdAt: event.timestamp
      }
      messages.set(event.messageId, message)
    }
    return message
  }

  private trackAttention(threadId: string, toolCallId: string, status: string): void {
    const waiting = this.waitingToolCalls.get(threadId) ?? new Set<string>()
    const wasWaiting = waiting.has(toolCallId)
    const isWaiting = status === 'waiting-for-user'
    if (wasWaiting === isWaiting) return
    if (isWaiting) waiting.add(toolCallId)
    else waiting.delete(toolCallId)
    this.waitingToolCalls.set(threadId, waiting)
    this.queueSummary(threadId)
  }

  private queueSummary(threadId: string): void {
    this.pendingSummaries.add(threadId)
    this.scheduleFlush()
  }

  private refreshSummary(threadId: string): void {
    const generation = (this.summaryGeneration.get(threadId) ?? 0) + 1
    this.summaryGeneration.set(threadId, generation)
    this.options
      .getThreadSummary(threadId)
      .then((summary) => {
        // A newer refresh started meanwhile; its result supersedes this one.
        if (!this.isRunning || this.summaryGeneration.get(threadId) !== generation) return
        if (summary) this.append({ type: 'thread.summary', threadId, summary })
      })
      .catch((error: unknown) => this.options.onError?.(error))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.coalesceMs)
  }

  private append(event: RemoteEvent): void {
    const entry: BufferedEvent = {
      seq: ++this.seq,
      at: this.now(),
      timestamp: new Date(this.now()).toISOString(),
      event
    }
    this.buffer.push(entry)
    this.trim()
    const push = this.toPush(entry)
    for (const subscriber of this.subscribers) {
      if (subscriber.live && this.wants(subscriber, event)) subscriber.push(push)
    }
  }

  private trim(): void {
    const cutoff = this.now() - this.bufferMaxAgeMs
    let drop = Math.max(0, this.buffer.length - this.bufferLimit)
    while (drop < this.buffer.length && this.buffer[drop]!.at < cutoff) drop += 1
    if (drop > 0) this.buffer.splice(0, drop)
  }

  private wants(subscriber: Subscriber, event: RemoteEvent): boolean {
    if (isRemoteInboxEvent(event)) return true
    return 'threadId' in event && subscriber.threads.has(event.threadId)
  }

  private toPush(entry: BufferedEvent): RemotePush {
    return {
      type: 'event',
      epoch: this.epoch,
      seq: entry.seq,
      timestamp: entry.timestamp,
      event: entry.event
    }
  }
}
