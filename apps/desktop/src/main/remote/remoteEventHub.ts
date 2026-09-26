import { Buffer } from 'node:buffer'
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
/** Past either bound, a thread's missed thread-scope events become one `thread.invalidated`. */
export const REMOTE_REPLAY_THREAD_EVENT_LIMIT = 256
export const REMOTE_REPLAY_THREAD_BYTE_LIMIT = 256 * 1024
/** Bounds of one `batch` push; a single larger event still travels alone. */
export const REMOTE_BATCH_ITEM_LIMIT = 256
export const REMOTE_BATCH_BYTE_LIMIT = 512 * 1024
/** Threads remembered by the inbox journal; evicting one raises the oldest resumable seq. */
export const REMOTE_JOURNAL_THREAD_LIMIT = 20_000

type DeltaEvent = Extract<RemoteEvent, { type: 'message.delta' | 'message.reasoning.delta' }>
type ToolUpdatedEvent = Extract<RemoteEvent, { type: 'tool.updated' }>
type RunStatusEvent = Extract<RemoteEvent, { type: 'run.status' }>

/** Preliminary tool output arrives many times a second; only the latest per window is sent. */
const COALESCED_TOOL_STATUSES: ReadonlySet<string> = new Set(['preparing', 'running'])

interface BufferedEvent {
  seq: number
  at: number
  timestamp: string
  event: RemoteEvent
  /** UTF-8 size of the serialized event, computed on first use. */
  bytes?: number
}

type PendingEntry =
  | { kind: 'delta'; event: DeltaEvent }
  | { kind: 'tool'; event: ToolUpdatedEvent; json: string }

interface ActiveMessage {
  id: string
  parentMessageId?: string
  content: string
  reasoning: string
  createdAt: string
}

/**
 * Latest inbox-scope state of one thread, kept outside the ring buffer so an inbox resume
 * still works after the ring has moved on. Summaries are fetched when replayed, not stored.
 */
export interface RemoteJournalEntry {
  presence?:
    | { seq: number; kind: 'summary'; deferred?: true }
    | { seq: number; kind: 'removed'; reason: 'archived' | 'deleted' }
  run?: { seq: number; event: RunStatusEvent }
}

/** What survives a clean desktop restart so phones keep their cursors. */
export interface RemoteEventHubState {
  epoch: string
  seq: number
  journalFloor: number
  /** Oldest first. */
  threads: Array<[string, RemoteJournalEntry]>
  appearance?: { seq: number; appearance: RemoteAppearance }
}

export interface RemoteEventHubPersistence {
  /** State recorded by the last clean shutdown, or null; the state is then marked in use. */
  open(): RemoteEventHubState | null
  /** Records a clean shutdown. */
  close(state: RemoteEventHubState): void
}

export interface RemoteEventHubOptions {
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  getThreadSummary(threadId: string): Promise<RemoteThreadSummary | null>
  /**
   * Whether a thread may reach the phone at all (null: the thread no longer exists). Without
   * it every thread is treated as visible.
   */
  getThreadVisibility?(threadId: string): Promise<boolean | null>
  persistence?: RemoteEventHubPersistence
  now?: () => number
  createEpoch?: () => string
  coalesceMs?: number
  bufferLimit?: number
  bufferMaxAgeMs?: number
  journalLimit?: number
  onError?: (error: unknown) => void
}

export interface RemoteEventSubscription {
  setThreads(threadIds: readonly string[]): void
  /**
   * Decides whether the phone can continue from `from` and, when it can, queues the missed
   * events (compacted). Nothing reaches the phone until `startDelivery`, which the caller
   * invokes right after sending this call's response; live events wait behind the replay.
   */
  resume(from?: { epoch: string; seq: number }): Promise<{
    epoch: string
    headSeq: number
    resumed: boolean
  }>
  /** Sends the queued replay, then everything since, and switches to live delivery. */
  startDelivery(): void
  close(): void
}

export interface RemoteAttachOptions {
  /** `event-batch` was negotiated: deliver `batch` pushes instead of one push per event. */
  batch?: boolean
}

interface Subscriber {
  push: (payload: RemotePush) => void
  batch: boolean
  threads: Set<string>
  /** idle: before the first subscribe; replaying: between resume and startDelivery. */
  mode: 'idle' | 'replaying' | 'live'
  deliveredThrough: number
  queued: BufferedEvent[]
  resumeGeneration: number
}

const RUN_TERMINAL_STATUS = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled'
} as const

function isDelta(event: RemoteEvent): event is DeltaEvent {
  return event.type === 'message.delta' || event.type === 'message.reasoning.delta'
}

function threadScopedId(event: RemoteEvent): string | null {
  return !isRemoteInboxEvent(event) && 'threadId' in event ? event.threadId : null
}

function sizeOf(entry: BufferedEvent): number {
  entry.bytes ??= Buffer.byteLength(JSON.stringify(entry.event), 'utf8')
  return entry.bytes
}

/**
 * Merges what a reconnecting phone missed: consecutive deltas per message and kind become one
 * delta at the last seq, deltas of messages completed within the replay are dropped (the
 * completion carries the full message), and only the latest summary per thread and the latest
 * update per tool call survive, each at its own seq. Everything else is kept in seq order.
 */
export function compactReplay<T extends { seq: number; event: RemoteEvent }>(items: T[]): T[] {
  const completed = new Set<string>()
  const lastSummary = new Map<string, number>()
  const lastTool = new Map<string, number>()
  items.forEach((item, index) => {
    const event = item.event
    if (event.type === 'message.completed') completed.add(event.message.id)
    else if (event.type === 'thread.summary') lastSummary.set(event.threadId, index)
    else if (event.type === 'tool.updated') lastTool.set(event.toolCall.id, index)
  })

  // A run of one message's deltas ends at that message's start/completion or a thread refetch.
  const runs: Array<{ threadId: string; indices: number[] }> = []
  const runOf = new Map<number, number>()
  const open = new Map<string, number>()
  items.forEach((item, index) => {
    const event = item.event
    if (isDelta(event)) {
      if (completed.has(event.messageId)) return
      const key = `${event.type}:${event.messageId}`
      let run = open.get(key)
      if (run === undefined) {
        run = runs.push({ threadId: event.threadId, indices: [] }) - 1
        open.set(key, run)
      }
      runs[run]!.indices.push(index)
      runOf.set(index, run)
    } else if (event.type === 'message.started' || event.type === 'message.completed') {
      const messageId = event.type === 'message.started' ? event.messageId : event.message.id
      open.delete(`message.delta:${messageId}`)
      open.delete(`message.reasoning.delta:${messageId}`)
    } else if (event.type === 'thread.invalidated') {
      for (const [key, run] of open) {
        if (runs[run]!.threadId === event.threadId) open.delete(key)
      }
    }
  })

  const compacted: T[] = []
  items.forEach((item, index) => {
    const event = item.event
    if (isDelta(event)) {
      if (completed.has(event.messageId)) return
      const run = runs[runOf.get(index)!]!
      if (run.indices.at(-1) !== index) return
      if (run.indices.length === 1) {
        compacted.push(item)
        return
      }
      const delta = run.indices.map((member) => (items[member]!.event as DeltaEvent).delta).join('')
      compacted.push({ ...item, bytes: undefined, event: { ...event, delta } })
      return
    }
    if (event.type === 'thread.summary' && lastSummary.get(event.threadId) !== index) return
    if (event.type === 'tool.updated' && lastTool.get(event.toolCall.id) !== index) return
    compacted.push(item)
  })
  return compacted
}

/** Splits events into `batch`-sized groups: at most 256 items and 512 KB unless one is larger. */
function batches(entries: BufferedEvent[]): BufferedEvent[][] {
  const groups: BufferedEvent[][] = []
  let current: BufferedEvent[] = []
  let bytes = 0
  for (const entry of entries) {
    const size = sizeOf(entry)
    if (
      current.length > 0 &&
      (current.length >= REMOTE_BATCH_ITEM_LIMIT || bytes + size > REMOTE_BATCH_BYTE_LIMIT)
    ) {
      groups.push(current)
      current = []
      bytes = 0
    }
    current.push(entry)
    bytes += size
  }
  if (current.length) groups.push(current)
  return groups
}

/**
 * Turns the server event stream into the remote stream: projects each event, merges text
 * deltas and preliminary tool output per 100 ms window, numbers events with a monotonic `seq`
 * under an `epoch`, and keeps a bounded ring buffer plus an inbox journal so a reconnecting
 * phone can resume. Epoch, seq and journal survive clean restarts through `persistence`.
 */
export class RemoteEventHub {
  readonly epoch: string
  private seq = 0
  /** Highest seq no longer in the ring; resumes at or after it can replay thread scope. */
  private ringFloor = 0
  /** Lowest cursor the journal still answers for. */
  private journalFloor = 0
  private readonly buffer: BufferedEvent[] = []
  private outgoing: BufferedEvent[] = []
  private readonly subscribers = new Set<Subscriber>()
  private readonly pending = new Map<string, PendingEntry>()
  private readonly pendingSummaries = new Set<string>()
  private readonly summariesInFlight = new Set<string>()
  private readonly summaryGeneration = new Map<string, number>()
  /** Serialized summary last appended per thread, to skip identical refreshes. */
  private readonly lastSummaries = new Map<string, string>()
  /** Serialized `tool.updated` last appended per tool call, to skip identical updates. */
  private readonly sentTools = new Map<string, { threadId: string; runId?: string; json: string }>()
  private readonly journal = new Map<string, RemoteJournalEntry>()
  private journalAppearance: { seq: number; appearance: RemoteAppearance } | null = null
  private readonly visibility = new Map<string, boolean>()
  private readonly heldInbox = new Map<string, RemoteEvent[]>()
  private readonly waitingToolCalls = new Map<string, Set<string>>()
  private readonly activeMessages = new Map<string, Map<string, Map<string, ActiveMessage>>>()
  private lastAppearance: string | null = null
  private settingsGeneration = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly now: () => number
  private readonly coalesceMs: number
  private readonly bufferLimit: number
  private readonly bufferMaxAgeMs: number
  private readonly journalLimit: number

  private readonly options: RemoteEventHubOptions

  constructor(options: RemoteEventHubOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.coalesceMs = options.coalesceMs ?? REMOTE_EVENT_COALESCE_MS
    this.bufferLimit = options.bufferLimit ?? REMOTE_EVENT_BUFFER_LIMIT
    this.bufferMaxAgeMs = options.bufferMaxAgeMs ?? REMOTE_EVENT_BUFFER_MAX_AGE_MS
    this.journalLimit = options.journalLimit ?? REMOTE_JOURNAL_THREAD_LIMIT
    const restored = options.persistence?.open() ?? null
    if (restored) {
      this.epoch = restored.epoch
      this.seq = restored.seq
      // The ring did not survive the restart: only the journal can answer older cursors.
      this.ringFloor = restored.seq
      this.journalFloor = restored.journalFloor
      for (const [threadId, entry] of restored.threads) this.journal.set(threadId, entry)
      if (restored.appearance) {
        this.journalAppearance = restored.appearance
        this.lastAppearance = `${restored.appearance.appearance.themeId}:${restored.appearance.appearance.themeAppearance}`
      }
    } else {
      this.epoch = options.createEpoch?.() ?? randomUUID()
    }
  }

  get isRunning(): boolean {
    return this.unsubscribe !== null
  }

  get headSeq(): number {
    return this.seq
  }

  /** Changes whenever desktop settings change; lets callers cache settings-derived answers. */
  get settingsVersion(): number {
    return this.settingsGeneration
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
    if (this.unsubscribe) {
      // Summaries still waiting or in flight changed after the last journal entry.
      for (const threadId of new Set([...this.pendingSummaries, ...this.summariesInFlight])) {
        this.deferSummary(threadId)
      }
      try {
        this.options.persistence?.close(this.exportState())
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.pending.clear()
    this.pendingSummaries.clear()
    this.summariesInFlight.clear()
    this.heldInbox.clear()
    this.activeMessages.clear()
    this.outgoing = []
    this.subscribers.clear()
  }

  attach(
    push: (payload: RemotePush) => void,
    options: RemoteAttachOptions = {}
  ): RemoteEventSubscription {
    const subscriber: Subscriber = {
      push,
      batch: options.batch ?? false,
      threads: new Set(),
      mode: 'idle',
      deliveredThrough: 0,
      queued: [],
      resumeGeneration: 0
    }
    this.subscribers.add(subscriber)
    return {
      setThreads: (threadIds) => {
        subscriber.threads = new Set(threadIds)
      },
      resume: (from) => this.resume(subscriber, from),
      startDelivery: () => {
        if (subscriber.mode !== 'replaying') return
        const queued = subscriber.queued
        subscriber.queued = []
        subscriber.mode = 'live'
        if (queued.length) this.send(subscriber, queued)
      },
      close: () => {
        this.subscribers.delete(subscriber)
      }
    }
  }

  /** Emits all merged deltas and tool updates now. */
  flush(): void {
    this.flushPending()
    this.deliver()
  }

  private async resume(
    subscriber: Subscriber,
    from: { epoch: string; seq: number } | undefined
  ): Promise<{ epoch: string; headSeq: number; resumed: boolean }> {
    const generation = ++subscriber.resumeGeneration
    // Journal summaries are fetched now rather than stored. Repeat until every summary the
    // synchronous commit below needs is at hand; nothing can interleave with the commit.
    const summaries = new Map<string, RemoteThreadSummary | null>()
    if (this.isResumable(from)) {
      for (;;) {
        const missing = this.journalSummaryIds(from.seq).filter((id) => !summaries.has(id))
        if (missing.length === 0 || !this.isRunning) break
        const fetched = await Promise.all(
          missing.map((threadId) => this.options.getThreadSummary(threadId))
        )
        missing.forEach((threadId, index) => summaries.set(threadId, fetched[index] ?? null))
      }
    }
    if (generation !== subscriber.resumeGeneration || !this.subscribers.has(subscriber)) {
      // A newer subscribe on this connection supersedes this one.
      return { epoch: this.epoch, headSeq: this.seq, resumed: false }
    }
    return this.commitResume(subscriber, from, summaries)
  }

  private commitResume(
    subscriber: Subscriber,
    from: { epoch: string; seq: number } | undefined,
    summaries: Map<string, RemoteThreadSummary | null>
  ): { epoch: string; headSeq: number; resumed: boolean } {
    this.trim()
    if (!this.isResumable(from)) {
      this.beginReplay(subscriber, [])
      return { epoch: this.epoch, headSeq: this.seq, resumed: false }
    }

    const cursor = from.seq
    const ringCovers = cursor >= this.ringFloor
    const items: BufferedEvent[] = []
    for (const entry of this.buffer) {
      if (entry.seq <= cursor || !this.wants(subscriber, entry.event)) continue
      if (ringCovers || isRemoteInboxEvent(entry.event)) items.push(entry)
    }
    // Inbox state that is not (or no longer) in the ring comes from the journal.
    const refetched: string[] = []
    for (const [threadId, entry] of this.journal) {
      const presence = entry.presence
      if (presence && presence.seq > cursor) {
        if (presence.kind === 'summary' && (presence.deferred || presence.seq <= this.ringFloor)) {
          const summary = summaries.get(threadId)
          if (summary) {
            items.push(this.synthetic(presence.seq, { type: 'thread.summary', threadId, summary }))
            if (presence.deferred) refetched.push(threadId)
          }
        } else if (presence.kind === 'removed' && presence.seq <= this.ringFloor) {
          items.push(
            this.synthetic(presence.seq, {
              type: 'thread.removed',
              threadId,
              reason: presence.reason
            })
          )
        }
      }
      if (entry.run && entry.run.seq > cursor && entry.run.seq <= this.ringFloor) {
        items.push(this.synthetic(entry.run.seq, entry.run.event))
      }
    }
    const appearance = this.journalAppearance
    if (appearance && appearance.seq > cursor && appearance.seq <= this.ringFloor) {
      items.push(
        this.synthetic(appearance.seq, {
          type: 'appearance.changed',
          appearance: appearance.appearance
        })
      )
    }
    items.sort((left, right) => left.seq - right.seq)

    let replay = compactReplay(items)
    if (ringCovers) {
      replay = this.limitThreadReplay(replay)
    } else {
      // Thread-scope history before the ring is gone: the phone must refetch open threads.
      for (const threadId of subscriber.threads) {
        replay.push(this.synthetic(++this.seq, { type: 'thread.invalidated', threadId }))
      }
    }
    // This phone now holds a freshly fetched summary; the next refresh must not be deduplicated
    // against the one other phones saw.
    for (const threadId of refetched) this.lastSummaries.delete(threadId)
    this.beginReplay(subscriber, replay)
    return { epoch: this.epoch, headSeq: this.seq, resumed: true }
  }

  /** Same epoch, not ahead of the head, and covered by the ring or the journal. */
  private isResumable(
    from: { epoch: string; seq: number } | undefined
  ): from is { epoch: string; seq: number } {
    return (
      from !== undefined &&
      from.epoch === this.epoch &&
      from.seq <= this.seq &&
      (from.seq >= this.ringFloor || from.seq >= this.journalFloor)
    )
  }

  private beginReplay(subscriber: Subscriber, replay: BufferedEvent[]): void {
    subscriber.mode = 'replaying'
    subscriber.queued = replay
    subscriber.deliveredThrough = this.seq
  }

  /** Threads whose journal summary a resume from `cursor` would replay. */
  private journalSummaryIds(cursor: number): string[] {
    const ids: string[] = []
    for (const [threadId, entry] of this.journal) {
      const presence = entry.presence
      if (
        presence?.kind === 'summary' &&
        presence.seq > cursor &&
        (presence.deferred || presence.seq <= this.ringFloor)
      ) {
        ids.push(threadId)
      }
    }
    return ids
  }

  /** Replaces an oversized per-thread replay with one refetch request at its last seq. */
  private limitThreadReplay(items: BufferedEvent[]): BufferedEvent[] {
    const stats = new Map<string, { count: number; bytes: number; last: number }>()
    items.forEach((item, index) => {
      const threadId = threadScopedId(item.event)
      if (!threadId) return
      const stat = stats.get(threadId) ?? { count: 0, bytes: 0, last: index }
      stat.count += 1
      stat.bytes += sizeOf(item)
      stat.last = index
      stats.set(threadId, stat)
    })
    const oversized = new Set(
      [...stats]
        .filter(
          ([, stat]) =>
            stat.count > REMOTE_REPLAY_THREAD_EVENT_LIMIT ||
            stat.bytes > REMOTE_REPLAY_THREAD_BYTE_LIMIT
        )
        .map(([threadId]) => threadId)
    )
    if (oversized.size === 0) return items
    return items.flatMap((item, index) => {
      const threadId = threadScopedId(item.event)
      if (!threadId || !oversized.has(threadId)) return [item]
      if (stats.get(threadId)!.last !== index) return []
      return [this.synthetic(item.seq, { type: 'thread.invalidated', threadId })]
    })
  }

  private synthetic(seq: number, event: RemoteEvent): BufferedEvent {
    const at = this.now()
    return { seq, at, timestamp: new Date(at).toISOString(), event }
  }

  private handle(event: YachiyoServerEvent): void {
    try {
      this.translate(event)
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.deliver()
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
        const pending = this.pending.get(key)
        if (pending?.kind === 'delta') {
          pending.event.delta += event.delta
        } else {
          this.pending.set(key, {
            kind: 'delta',
            event: {
              type: event.type,
              threadId: event.threadId,
              runId: event.runId,
              messageId: event.messageId,
              delta: event.delta
            }
          })
        }
        this.scheduleFlush()
        return
      }
      case 'thread.created':
      case 'thread.updated':
      case 'thread.restored':
        this.queueSummary(event.threadId)
        return
      case 'settings.updated': {
        this.settingsGeneration += 1
        const appearance: RemoteAppearance = {
          themeId: event.config.general?.themeId ?? 'mizu',
          themeAppearance: event.config.general?.themeAppearance ?? 'system'
        }
        const key = `${appearance.themeId}:${appearance.themeAppearance}`
        if (key === this.lastAppearance) return
        this.lastAppearance = key
        this.flushPending()
        this.append({ type: 'appearance.changed', appearance })
        return
      }
      case 'tool.updated':
        this.translateToolUpdate(event)
        return
    }

    const translated = this.translateOrdered(event)
    if (translated.length === 0) return
    this.flushPending()
    for (const remoteEvent of translated) this.appendVisible(remoteEvent)
  }

  private translateOrdered(event: YachiyoServerEvent): RemoteEvent[] {
    switch (event.type) {
      case 'thread.archived':
      case 'thread.deleted':
        this.waitingToolCalls.delete(event.threadId)
        this.activeMessages.delete(event.threadId)
        this.forgetThreadTools(event.threadId)
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
        for (const [toolCallId, sent] of this.sentTools) {
          if (sent.runId === event.runId) this.sentTools.delete(toolCallId)
        }
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
      case 'todo.updated':
        return [
          { type: 'todo.updated', threadId: event.threadId, items: projectTodoItems(event.items) }
        ]
      // Subagent and background-task events are not forwarded: `tasks.changed` has no consumer
      // on the phone, which reads `tasks.list` on demand.
      default:
        return []
    }
  }

  /**
   * Preliminary output (`preparing`/`running`) is coalesced per tool call inside the delta
   * window, keeping the latest projection at the position of the first. Any other status is a
   * transition: pending events flush first so it stays ordered after them. A projection equal
   * to the last one sent for that call is dropped.
   */
  private translateToolUpdate(event: Extract<YachiyoServerEvent, { type: 'tool.updated' }>): void {
    this.trackAttention(event.threadId, event.toolCall.id, event.toolCall.status)
    const remote: ToolUpdatedEvent = {
      type: 'tool.updated',
      threadId: event.threadId,
      ...(event.runId ? { runId: event.runId } : {}),
      toolCall: projectToolCall(event.toolCall)
    }
    const json = JSON.stringify(remote)
    const key = `tool:${event.toolCall.id}`
    const sent = this.sentTools.get(event.toolCall.id)?.json
    if (COALESCED_TOOL_STATUSES.has(event.toolCall.status)) {
      if (sent === json) {
        this.pending.delete(key)
        return
      }
      const pending = this.pending.get(key)
      if (pending?.kind === 'tool') {
        pending.event = remote
        pending.json = json
      } else {
        this.pending.set(key, { kind: 'tool', event: remote, json })
      }
      this.scheduleFlush()
      return
    }
    this.pending.delete(key)
    this.flushPending()
    if (sent === json) return
    this.appendTool(remote, json)
  }

  private appendTool(event: ToolUpdatedEvent, json: string): void {
    this.append(event)
    this.sentTools.set(event.toolCall.id, {
      threadId: event.threadId,
      ...(event.runId ? { runId: event.runId } : {}),
      json
    })
  }

  private forgetThreadTools(threadId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.event.threadId === threadId && entry.kind === 'tool') this.pending.delete(key)
    }
    for (const [toolCallId, sent] of this.sentTools) {
      if (sent.threadId === threadId) this.sentTools.delete(toolCallId)
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

  /**
   * Inbox events reach every phone, so threads the phone may not see (guest channel DMs) are
   * filtered here. The first event of a thread waits for one visibility lookup.
   */
  private appendVisible(event: RemoteEvent): void {
    const threadId =
      event.type === 'run.status' || event.type === 'thread.removed' ? event.threadId : null
    if (!threadId || !this.options.getThreadVisibility) {
      this.append(event)
      return
    }
    const known = this.visibility.get(threadId)
    const held = this.heldInbox.get(threadId)
    if (known !== undefined && !held) {
      if (known) this.append(event)
      if (event.type === 'thread.removed' && event.reason === 'deleted') {
        this.visibility.delete(threadId)
      }
      return
    }
    if (held) {
      held.push(event)
      return
    }
    this.heldInbox.set(threadId, [event])
    this.options
      .getThreadVisibility(threadId)
      .then(
        (visible) => this.releaseHeld(threadId, visible),
        (error: unknown) => {
          this.options.onError?.(error)
          this.releaseHeld(threadId, false)
        }
      )
      .finally(() => this.deliver())
  }

  private releaseHeld(threadId: string, visible: boolean | null): void {
    const held = this.heldInbox.get(threadId)
    this.heldInbox.delete(threadId)
    if (!this.isRunning || !held) return
    if (visible !== null) this.visibility.set(threadId, visible)
    for (const event of held) {
      // A thread that no longer exists cannot be checked; its removal is still announced so a
      // phone that listed it drops it.
      if (visible === true || (visible === null && event.type === 'thread.removed')) {
        this.append(event)
      }
      if (event.type === 'thread.removed' && event.reason === 'deleted') {
        this.visibility.delete(threadId)
      }
    }
  }

  private queueSummary(threadId: string): void {
    this.pendingSummaries.add(threadId)
    this.scheduleFlush()
  }

  private refreshSummary(threadId: string): void {
    const generation = (this.summaryGeneration.get(threadId) ?? 0) + 1
    this.summaryGeneration.set(threadId, generation)
    if (this.subscribers.size === 0) {
      // No phone is connected: record that the summary changed; a resume fetches it then.
      this.summariesInFlight.delete(threadId)
      this.deferSummary(threadId)
      return
    }
    this.summariesInFlight.add(threadId)
    this.options
      .getThreadSummary(threadId)
      .then((summary) => {
        // A newer refresh started meanwhile; its result supersedes this one.
        if (!this.isRunning || this.summaryGeneration.get(threadId) !== generation) return
        this.summariesInFlight.delete(threadId)
        if (!summary) return
        const json = JSON.stringify(summary)
        if (this.lastSummaries.get(threadId) === json) return
        this.append({ type: 'thread.summary', threadId, summary })
        this.lastSummaries.set(threadId, json)
        this.deliver()
      })
      .catch((error: unknown) => {
        if (this.summaryGeneration.get(threadId) === generation) {
          this.summariesInFlight.delete(threadId)
          // Keep the change resumable even though no summary could be sent now.
          if (this.isRunning) this.deferSummary(threadId)
        }
        this.options.onError?.(error)
      })
  }

  private deferSummary(threadId: string): void {
    this.lastSummaries.delete(threadId)
    this.updateJournal(threadId, (entry) => {
      entry.presence = { seq: ++this.seq, kind: 'summary', deferred: true }
    })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.coalesceMs)
  }

  private flushPending(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.kind === 'delta') this.append({ ...entry.event })
      else this.appendTool(entry.event, entry.json)
    }
    const summaries = [...this.pendingSummaries]
    this.pendingSummaries.clear()
    for (const threadId of summaries) this.refreshSummary(threadId)
  }

  private append(event: RemoteEvent): void {
    const at = this.now()
    const entry: BufferedEvent = {
      seq: ++this.seq,
      at,
      timestamp: new Date(at).toISOString(),
      event
    }
    this.buffer.push(entry)
    this.trim()
    this.recordJournal(entry)
    this.outgoing.push(entry)
  }

  /** Hands appended events to subscribers: live ones get them now, replaying ones later. */
  private deliver(): void {
    if (this.outgoing.length === 0) return
    const entries = this.outgoing
    this.outgoing = []
    for (const subscriber of this.subscribers) {
      if (subscriber.mode === 'idle') continue
      const wanted = entries.filter(
        (entry) => entry.seq > subscriber.deliveredThrough && this.wants(subscriber, entry.event)
      )
      if (wanted.length === 0) continue
      if (subscriber.mode === 'replaying') subscriber.queued.push(...wanted)
      else this.send(subscriber, wanted)
    }
  }

  private send(subscriber: Subscriber, entries: BufferedEvent[]): void {
    if (subscriber.batch) {
      for (const group of batches(entries)) {
        subscriber.push({
          type: 'batch',
          epoch: this.epoch,
          timestamp: group.at(-1)!.timestamp,
          items: group.map((entry) => ({ seq: entry.seq, event: entry.event }))
        })
      }
    } else {
      for (const entry of entries) subscriber.push(this.toPush(entry))
    }
    subscriber.deliveredThrough = Math.max(subscriber.deliveredThrough, entries.at(-1)!.seq)
  }

  private recordJournal(entry: BufferedEvent): void {
    const event = entry.event
    switch (event.type) {
      case 'thread.summary':
        this.updateJournal(event.threadId, (journal) => {
          journal.presence = { seq: entry.seq, kind: 'summary' }
        })
        return
      case 'thread.removed':
        this.lastSummaries.delete(event.threadId)
        this.updateJournal(event.threadId, (journal) => {
          journal.presence = { seq: entry.seq, kind: 'removed', reason: event.reason }
        })
        return
      case 'run.status':
        this.updateJournal(event.threadId, (journal) => {
          journal.run = { seq: entry.seq, event }
        })
        return
      case 'appearance.changed':
        this.journalAppearance = { seq: entry.seq, appearance: event.appearance }
        return
    }
  }

  private updateJournal(threadId: string, update: (entry: RemoteJournalEntry) => void): void {
    const entry = this.journal.get(threadId) ?? {}
    // Re-insert so iteration order stays oldest-updated first for eviction.
    this.journal.delete(threadId)
    update(entry)
    this.journal.set(threadId, entry)
    while (this.journal.size > this.journalLimit) {
      const [oldestId, oldest] = this.journal.entries().next().value!
      this.journal.delete(oldestId)
      this.journalFloor = Math.max(
        this.journalFloor,
        oldest.presence?.seq ?? 0,
        oldest.run?.seq ?? 0
      )
    }
  }

  private exportState(): RemoteEventHubState {
    return {
      epoch: this.epoch,
      seq: this.seq,
      journalFloor: this.journalFloor,
      threads: [...this.journal],
      ...(this.journalAppearance ? { appearance: this.journalAppearance } : {})
    }
  }

  private trim(): void {
    const cutoff = this.now() - this.bufferMaxAgeMs
    let drop = Math.max(0, this.buffer.length - this.bufferLimit)
    while (drop < this.buffer.length && this.buffer[drop]!.at < cutoff) drop += 1
    if (drop > 0) {
      this.ringFloor = Math.max(this.ringFloor, this.buffer[drop - 1]!.seq)
      this.buffer.splice(0, drop)
    }
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
