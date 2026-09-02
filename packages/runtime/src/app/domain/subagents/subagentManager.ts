import type { ToolSet } from 'ai'
import type {
  AgentEndpoint,
  AgentMessageEnvelope,
  AgentMessageReceipt,
  ComposerReasoningSelection,
  NamedSubagentId,
  RunModeId,
  SendAgentMessageInput,
  SendChatRunTrigger,
  SubagentLaunchReceipt,
  SubagentProgressEvent,
  SubagentSnapshot,
  SubagentSnapshotReadyEvent,
  SubagentState,
  SubagentToolCallEvent,
  SubagentUpdatedEvent,
  ToolCallName,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { isRetryableRunError } from '../../../runtime/models/runtimeErrors.ts'

export const MAX_LIVE_AGENTS_PER_THREAD = 8
export const MAX_RUNNING_AGENTS_GLOBAL = 16
export const MAX_MAILBOX_ENVELOPES = 32
export const MAX_MAILBOX_BYTES = 64 * 1024
export const MAX_TURNS_PER_AGENT = 32
export const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000
export const MAX_AGENT_MESSAGE_LENGTH = 8_000
export const MAX_TASK_PROGRESS_LENGTH = 12_000

export interface SubagentParentDeliveryContext {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  runMode: RunModeId
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  channelHint?: string
  extraTools?: ToolSet
}

export interface LaunchSubagentInput {
  agentId: string
  parentThreadId: string
  launchRunId: string
  requestMessageId?: string
  agentName: string
  agentType: NamedSubagentId
  codeName: string
  workspacePath: string
  prompt: string
  parentDeliveryContext?: SubagentParentDeliveryContext
  runnerFactory?: SubagentRunnerFactory
  deliverToParent?: (input: DeliverSubagentToParentInput) => Promise<void> | void
}

export interface SubagentRunnerTurnInput {
  turnId: string
  initialPrompt?: string
  messages: AgentMessageEnvelope[]
  signal: AbortSignal
}

export interface SubagentTurnResult {
  output: string
  promptTokens?: number
  completionTokens?: number
}

export interface SubagentRunner {
  runTurn(input: SubagentRunnerTurnInput): Promise<SubagentTurnResult>
  close(): Promise<void | { snapshotId?: string }>
}

export interface SubagentRunnerFactoryInput {
  launch: LaunchSubagentInput
  signal: AbortSignal
  sendMessage: (input: SendAgentMessageInput) => AgentMessageReceipt
  getTask: (taskId: string) => SubagentSnapshot | undefined
  hasPendingMessages: () => boolean
  onProgress: (input: { turnId: string; chunk: string }) => void
  onToolCall: (input: {
    turnId: string
    toolCallId?: string
    toolName: string
    inputSummary: string
    outputSummary?: string
    status?: 'running' | 'completed' | 'failed'
  }) => void
}

export type SubagentRunnerFactory = (input: SubagentRunnerFactoryInput) => SubagentRunner

export interface DeliverSubagentToParentInput {
  agentId: string
  parentThreadId: string
  launchRunId: string
  message: string
  kind: 'initial-result' | 'message'
  parentDeliveryContext?: SubagentParentDeliveryContext
  envelope?: AgentMessageEnvelope
}

export interface SubagentManagerLimits {
  maxLiveAgentsPerThread: number
  maxRunningAgentsGlobal: number
  maxMailboxEnvelopes: number
  maxMailboxBytes: number
  maxTurnsPerAgent: number
}

export interface SubagentManagerDeps {
  createId: () => string
  timestamp: () => string
  emit: (event: YachiyoServerEvent) => void
  onSnapshot?: (snapshot: SubagentSnapshot) => void
  runnerFactory: SubagentRunnerFactory
  deliverToParent: (input: DeliverSubagentToParentInput) => Promise<void> | void
  getParentState: (threadId: string) => 'running' | 'idle'
  idleTtlMs?: number
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout
  clearTimer?: (timer: NodeJS.Timeout) => void
  limits?: Partial<SubagentManagerLimits>
}

type StoredLaunchSubagentInput = Omit<LaunchSubagentInput, 'runnerFactory' | 'deliverToParent'>

interface AgentRecord {
  readonly launch: StoredLaunchSubagentInput
  readonly deliverToParent: (input: DeliverSubagentToParentInput) => Promise<void> | void
  readonly controller: AbortController
  readonly runner: SubagentRunner
  readonly mailbox: AgentMessageEnvelope[]
  readonly parentMessagesThisTurn: Set<string>
  snapshot: SubagentSnapshot
  mailboxBytes: number
  nextSequence: number
  turnCount: number
  initialResultDelivered: boolean
  idleTimer?: NodeJS.Timeout
  drainPromise?: Promise<void>
  closePromise?: Promise<void>
}

const TERMINAL_STATES = new Set<SubagentState>(['failed', 'cancelled', 'closed', 'interrupted'])

function isTerminalState(state: SubagentState): boolean {
  return TERMINAL_STATES.has(state)
}

function cloneSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
  return { ...snapshot }
}

function messageBytes(message: string): number {
  return Buffer.byteLength(message, 'utf8')
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns detached Worker lifetimes, team routing, mailboxes, and idle cleanup.
 * Provider execution is supplied through the runner adapter and never runs in
 * the parent tool invocation.
 */
export class SubagentManager {
  private readonly deps: SubagentManagerDeps
  private readonly agents = new Map<string, AgentRecord>()
  private readonly parentSequences = new Map<string, number>()
  private readonly idleTtlMs: number
  private readonly limits: SubagentManagerLimits
  private readonly pendingResourceCloses = new Set<Promise<void>>()
  private closing = false

  constructor(deps: SubagentManagerDeps) {
    this.deps = deps
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.limits = {
      maxLiveAgentsPerThread: deps.limits?.maxLiveAgentsPerThread ?? MAX_LIVE_AGENTS_PER_THREAD,
      maxRunningAgentsGlobal: deps.limits?.maxRunningAgentsGlobal ?? MAX_RUNNING_AGENTS_GLOBAL,
      maxMailboxEnvelopes: deps.limits?.maxMailboxEnvelopes ?? MAX_MAILBOX_ENVELOPES,
      maxMailboxBytes: deps.limits?.maxMailboxBytes ?? MAX_MAILBOX_BYTES,
      maxTurnsPerAgent: deps.limits?.maxTurnsPerAgent ?? MAX_TURNS_PER_AGENT
    }

    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs <= 0) {
      throw new Error(`idleTtlMs must be a positive finite number, got ${this.idleTtlMs}.`)
    }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got ${value}.`)
      }
    }
  }

  async launch(input: LaunchSubagentInput): Promise<SubagentLaunchReceipt> {
    if (this.closing) {
      throw new Error('Subagent manager is closing and does not accept new agents.')
    }
    if (!input.agentId.trim()) throw new Error('Agent ID must not be empty.')
    if (!input.parentThreadId.trim()) throw new Error('Parent thread ID must not be empty.')
    if (!input.launchRunId.trim()) throw new Error('Launch run ID must not be empty.')
    if (!input.prompt.trim()) throw new Error('Agent prompt must not be empty.')
    if (this.agents.has(input.agentId)) {
      throw new Error(`Agent "${input.agentId}" is already registered.`)
    }

    const liveInThread = [...this.agents.values()].filter(
      (record) =>
        record.launch.parentThreadId === input.parentThreadId &&
        !isTerminalState(record.snapshot.state)
    ).length
    if (liveInThread >= this.limits.maxLiveAgentsPerThread) {
      throw new Error(
        `Thread "${input.parentThreadId}" already has the maximum of ${this.limits.maxLiveAgentsPerThread} live agents.`
      )
    }
    const runningCount = [...this.agents.values()].filter(
      (record) => record.snapshot.state === 'starting' || record.snapshot.state === 'running'
    ).length
    if (runningCount >= this.limits.maxRunningAgentsGlobal) {
      throw new Error(
        `The process already has the maximum of ${this.limits.maxRunningAgentsGlobal} running agents.`
      )
    }

    const {
      runnerFactory: launchRunnerFactory,
      deliverToParent: launchDeliverToParent,
      ...storedLaunch
    } = input
    const controller = new AbortController()
    const runner = (launchRunnerFactory ?? this.deps.runnerFactory)({
      launch: storedLaunch,
      signal: controller.signal,
      sendMessage: (messageInput) =>
        this.send({
          from: { kind: 'agent', agentId: input.agentId },
          ...messageInput
        }),
      getTask: (taskId) => this.get({ kind: 'agent', agentId: input.agentId }, taskId),
      hasPendingMessages: () => this.hasPendingMessages(input.agentId),
      onProgress: ({ turnId, chunk }) => {
        this.appendProgress(input.agentId, chunk)
        this.emitProgress(storedLaunch, turnId, chunk)
      },
      onToolCall: (event) => {
        this.emitToolCall(storedLaunch, event)
      }
    })
    if (!runner || typeof runner.runTurn !== 'function' || typeof runner.close !== 'function') {
      throw new Error(`Runner factory returned an invalid runner for agent "${input.agentId}".`)
    }

    const startedAt = this.deps.timestamp()
    const snapshot: SubagentSnapshot = {
      agentId: input.agentId,
      parentThreadId: input.parentThreadId,
      launchRunId: input.launchRunId,
      ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
      agentName: input.agentName,
      agentType: input.agentType,
      codeName: input.codeName,
      workspacePath: input.workspacePath,
      state: 'starting',
      startedAt,
      updatedAt: startedAt
    }
    const record: AgentRecord = {
      launch: storedLaunch,
      deliverToParent: launchDeliverToParent ?? this.deps.deliverToParent,
      controller,
      runner,
      mailbox: [],
      parentMessagesThisTurn: new Set(),
      snapshot,
      mailboxBytes: 0,
      nextSequence: 1,
      turnCount: 0,
      initialResultDelivered: false
    }
    this.agents.set(input.agentId, record)
    this.emitSnapshot(record)
    this.setState(record, 'running')
    this.startDrain(record)

    return {
      agentId: input.agentId,
      codeName: input.codeName,
      state: 'running',
      workspacePath: input.workspacePath
    }
  }

  send(input: {
    from: AgentEndpoint
    to: 'parent' | string
    message: string
  }): AgentMessageReceipt {
    if (this.closing) {
      throw new Error('Subagent manager is closing and does not accept new task steers.')
    }
    const message = input.message.trim()
    if (!message) throw new Error('Task steer must not be empty.')
    if (message.length > MAX_AGENT_MESSAGE_LENGTH) {
      throw new Error(`Task steers may contain at most ${MAX_AGENT_MESSAGE_LENGTH} characters.`)
    }

    const senderRecord =
      input.from.kind === 'agent' ? this.agents.get(input.from.agentId) : undefined
    if (input.from.kind === 'agent') {
      if (!senderRecord) throw new Error(`Unknown sender task "${input.from.agentId}".`)
      if (isTerminalState(senderRecord.snapshot.state)) {
        throw new Error(`Terminal task "${input.from.agentId}" cannot send steers.`)
      }
    }

    if (input.from.kind === 'parent' && input.to === 'parent') {
      throw new Error('Parent agents cannot steer the parent endpoint.')
    }

    if (input.to === 'parent') {
      if (!senderRecord) {
        throw new Error('Only a Worker task can steer the parent endpoint.')
      }
      const parentThreadId = senderRecord.launch.parentThreadId
      const sequence = this.nextParentSequence(parentThreadId)
      const envelope: AgentMessageEnvelope = {
        id: this.deps.createId(),
        teamThreadId: parentThreadId,
        sequence,
        from: input.from,
        to: { kind: 'parent', threadId: parentThreadId },
        message,
        createdAt: this.deps.timestamp()
      }
      const recipientState = this.deps.getParentState(parentThreadId)
      this.emitMessage(senderRecord, envelope)
      this.deliver(senderRecord, envelope, 'message', message)
      senderRecord.parentMessagesThisTurn.add(message)
      return { messageId: envelope.id, delivery: 'queued', recipientState }
    }

    const recipient = this.agents.get(input.to)
    if (!recipient) throw new Error(`Unknown recipient task "${input.to}".`)
    if (isTerminalState(recipient.snapshot.state)) {
      throw new Error(`Terminal task "${input.to}" cannot receive steers.`)
    }
    let teamThreadId: string
    if (senderRecord) {
      teamThreadId = senderRecord.launch.parentThreadId
    } else if (input.from.kind === 'parent') {
      teamThreadId = input.from.threadId
    } else {
      throw new Error(`Unknown sender task "${input.from.agentId}".`)
    }
    if (recipient.launch.parentThreadId !== teamThreadId) {
      throw new Error(`Agent "${input.to}" is not in the sender's task team.`)
    }
    if (input.from.kind === 'agent' && input.from.agentId === recipient.launch.agentId) {
      throw new Error('A task cannot steer itself.')
    }

    const bytes = messageBytes(message)
    if (recipient.mailbox.length >= this.limits.maxMailboxEnvelopes) {
      throw new Error(`Agent "${input.to}" mailbox is full.`)
    }
    if (recipient.mailboxBytes + bytes > this.limits.maxMailboxBytes) {
      throw new Error(`Agent "${input.to}" mailbox byte limit exceeded.`)
    }

    const envelope: AgentMessageEnvelope = {
      id: this.deps.createId(),
      teamThreadId,
      sequence: recipient.nextSequence++,
      from: input.from,
      to: { kind: 'agent', agentId: recipient.launch.agentId },
      message,
      createdAt: this.deps.timestamp()
    }
    recipient.mailbox.push(envelope)
    recipient.mailboxBytes += bytes
    const recipientState = recipient.snapshot.state === 'idle' ? 'idle' : 'running'
    this.emitMessage(recipient, envelope)
    if (recipient.snapshot.state === 'idle') {
      this.clearIdleTimer(recipient)
      this.setState(recipient, 'running')
      this.startDrain(recipient)
    }
    return { messageId: envelope.id, delivery: 'queued', recipientState }
  }

  cancel(agentId: string): boolean {
    const record = this.agents.get(agentId)
    if (!record || isTerminalState(record.snapshot.state)) return false
    return this.cancelRecord(record, !this.closing)
  }

  private cancelRecord(record: AgentRecord, notifyParent: boolean): boolean {
    this.clearIdleTimer(record)
    this.setState(record, 'cancelled')
    if (notifyParent) {
      const kind = record.initialResultDelivered ? 'message' : 'initial-result'
      record.initialResultDelivered = true
      this.deliver(record, undefined, kind, `Task ${record.launch.agentId} was cancelled.`)
    }
    record.controller.abort(new Error('Task cancelled.'))
    return true
  }
  cancelRunningByThread(threadId: string): number {
    let cancelled = 0
    for (const record of this.agents.values()) {
      if (
        record.launch.parentThreadId === threadId &&
        (record.snapshot.state === 'starting' || record.snapshot.state === 'running') &&
        this.cancel(record.launch.agentId)
      ) {
        cancelled += 1
      }
    }
    return cancelled
  }
  async closeThread(threadId: string): Promise<void> {
    const allRecords = [...this.agents.values()].filter(
      (record) => record.launch.parentThreadId === threadId
    )
    const liveRecords = allRecords.filter((record) => !isTerminalState(record.snapshot.state))
    for (const record of liveRecords) {
      this.clearIdleTimer(record)
      if (record.snapshot.state === 'idle') {
        this.setState(record, 'closed')
        this.startRunnerClose(record)
      } else {
        this.cancelRecord(record, false)
      }
    }
    await Promise.allSettled(
      liveRecords.flatMap((record) => [
        ...(record.drainPromise ? [record.drainPromise] : []),
        ...(record.closePromise ? [record.closePromise] : [])
      ])
    )
    await Promise.allSettled([...this.pendingResourceCloses])
    for (const record of allRecords) {
      this.agents.delete(record.launch.agentId)
    }
  }

  closeIdle(agentId: string): boolean {
    const record = this.agents.get(agentId)
    if (!record || record.snapshot.state !== 'idle') return false
    this.clearIdleTimer(record)
    this.setState(record, 'closed')
    this.startRunnerClose(record)
    return true
  }

  list(threadId?: string): SubagentSnapshot[] {
    return [...this.agents.values()]
      .filter((record) => threadId === undefined || record.launch.parentThreadId === threadId)
      .map((record) => cloneSnapshot(record.snapshot))
  }

  get(requester: AgentEndpoint, taskId: string): SubagentSnapshot | undefined {
    const record = this.agents.get(taskId)
    if (!record) return undefined
    const requesterThreadId =
      requester.kind === 'parent'
        ? requester.threadId
        : this.agents.get(requester.agentId)?.launch.parentThreadId
    if (!requesterThreadId || record.launch.parentThreadId !== requesterThreadId) return undefined
    return cloneSnapshot(record.snapshot)
  }

  async close(): Promise<void> {
    if (this.closing) {
      await Promise.allSettled([...this.pendingResourceCloses])
      return
    }
    this.closing = true
    for (const record of this.agents.values()) {
      this.clearIdleTimer(record)
      if (record.snapshot.state === 'starting' || record.snapshot.state === 'running') {
        this.setState(record, 'cancelled')
        record.controller.abort(new Error('Subagent manager is closing.'))
      } else if (record.snapshot.state === 'idle') {
        this.setState(record, 'closed')
        this.startRunnerClose(record)
      }
    }
    await Promise.allSettled([
      ...[...this.agents.values()]
        .map((record) => record.drainPromise)
        .filter((promise): promise is Promise<void> => promise !== undefined),
      ...this.pendingResourceCloses
    ])
    this.agents.clear()
    this.parentSequences.clear()
  }

  private startDrain(record: AgentRecord): void {
    if (record.drainPromise || isTerminalState(record.snapshot.state) || this.closing) return
    const drainPromise = this.drain(record)
    record.drainPromise = drainPromise
    void drainPromise.finally(() => {
      if (record.drainPromise !== drainPromise) return
      record.drainPromise = undefined
      if (
        record.snapshot.state === 'running' &&
        record.mailbox.length > 0 &&
        !record.controller.signal.aborted &&
        !this.closing
      ) {
        record.snapshot = {
          ...record.snapshot,
          error: undefined,
          updatedAt: this.deps.timestamp()
        }
        this.emitSnapshot(record)
        this.startDrain(record)
      }
    })
  }

  private async drain(record: AgentRecord): Promise<void> {
    try {
      while (record.snapshot.state === 'running' && !this.closing) {
        record.parentMessagesThisTurn.clear()
        const messages = record.mailbox.splice(0)
        record.mailboxBytes = 0
        const turnId = this.deps.createId()
        record.turnCount += 1
        record.snapshot = {
          ...record.snapshot,
          currentTurnId: turnId,
          updatedAt: this.deps.timestamp()
        }
        this.emitSnapshot(record)
        const result = await record.runner.runTurn({
          turnId,
          ...(record.turnCount === 1 ? { initialPrompt: record.launch.prompt } : {}),
          messages,
          signal: record.controller.signal
        })
        if (
          record.snapshot.state !== 'running' ||
          record.controller.signal.aborted ||
          this.closing
        ) {
          this.startRunnerClose(record)
          return
        }
        this.applyTurnResult(record, result)

        if (record.turnCount >= this.limits.maxTurnsPerAgent) {
          record.snapshot = {
            ...record.snapshot,
            currentTurnId: undefined,
            error: `Task reached the maximum of ${this.limits.maxTurnsPerAgent} turns.`,
            updatedAt: this.deps.timestamp()
          }
          this.emitSnapshot(record)
          this.deliver(
            record,
            undefined,
            'message',
            `Task reached the maximum of ${this.limits.maxTurnsPerAgent} turns and was closed.`
          )
          this.setState(record, 'closed')
          this.startRunnerClose(record)
          return
        }
        if (record.mailbox.length > 0) continue
        this.setState(record, 'idle')
        this.scheduleIdleTimer(record)
        return
      }
    } catch (error) {
      if (
        record.snapshot.state === 'cancelled' ||
        record.controller.signal.aborted ||
        this.closing
      ) {
        if (record.snapshot.state !== 'cancelled' && !this.closing)
          this.setState(record, 'cancelled')
      } else {
        const errorMessage = asErrorMessage(error)
        record.snapshot = {
          ...record.snapshot,
          currentTurnId: undefined,
          error: errorMessage,
          updatedAt: this.deps.timestamp()
        }
        this.emitSnapshot(record)
        const kind = record.initialResultDelivered ? 'message' : 'initial-result'
        record.initialResultDelivered = true
        if (isRetryableRunError(error)) {
          this.deliver(
            record,
            undefined,
            kind,
            `Task ${record.launch.agentId} was interrupted after retrying: ${errorMessage}. Use steerTask to continue this Worker.`
          )
          if (record.mailbox.length === 0) {
            this.setState(record, 'idle')
            this.scheduleIdleTimer(record)
          }
        } else {
          this.deliver(
            record,
            undefined,
            kind,
            `Task ${record.launch.agentId} failed: ${errorMessage}`
          )
          this.setState(record, 'failed')
        }
      }
      if (isTerminalState(record.snapshot.state)) this.startRunnerClose(record)
    } finally {
      if (isTerminalState(record.snapshot.state)) this.startRunnerClose(record)
    }
  }

  private applyTurnResult(record: AgentRecord, result: SubagentTurnResult): void {
    const output = result.output.trim()
    record.snapshot = {
      ...record.snapshot,
      currentTurnId: undefined,
      ...(output ? { lastOutput: result.output } : {}),
      ...(result.promptTokens !== undefined
        ? {
            cumulativePromptTokens:
              (record.snapshot.cumulativePromptTokens ?? 0) + result.promptTokens
          }
        : {}),
      ...(result.completionTokens !== undefined
        ? {
            cumulativeCompletionTokens:
              (record.snapshot.cumulativeCompletionTokens ?? 0) + result.completionTokens
          }
        : {}),
      error: undefined,
      updatedAt: this.deps.timestamp()
    }
    this.emitSnapshot(record)
    const kind = record.initialResultDelivered ? 'message' : 'initial-result'
    record.initialResultDelivered = true
    const message = output || 'Task completed without a final text response.'
    if (!record.parentMessagesThisTurn.has(message)) {
      this.deliver(record, undefined, kind, message)
    }
    record.parentMessagesThisTurn.clear()
  }

  private deliver(
    record: AgentRecord,
    envelope: AgentMessageEnvelope | undefined,
    kind: 'initial-result' | 'message',
    message?: string
  ): void {
    const deliveryMessage = message ?? envelope?.message
    if (!deliveryMessage) throw new Error('Cannot deliver an empty task message.')
    const tracked = Promise.resolve()
      .then(() =>
        record.deliverToParent({
          agentId: record.launch.agentId,
          parentThreadId: record.launch.parentThreadId,
          launchRunId: record.launch.launchRunId,
          message: deliveryMessage,
          kind,
          ...(envelope ? { envelope } : {}),
          ...(record.launch.parentDeliveryContext
            ? { parentDeliveryContext: record.launch.parentDeliveryContext }
            : {})
        })
      )
      .catch((error: unknown) => {
        const deliveryError = `Parent delivery failed: ${asErrorMessage(error)}`
        record.snapshot = {
          ...record.snapshot,
          error: record.snapshot.error
            ? `${record.snapshot.error}; ${deliveryError}`
            : deliveryError,
          updatedAt: this.deps.timestamp()
        }
        this.emitSnapshot(record)
      })
    this.pendingResourceCloses.add(tracked)
    void tracked.finally(() => this.pendingResourceCloses.delete(tracked))
  }

  private startRunnerClose(record: AgentRecord): void {
    if (record.closePromise) return
    const closePromise = Promise.resolve()
      .then(async () => {
        const result = await record.runner.close()
        if (result && result.snapshotId) {
          this.emitSnapshotReady(record, result.snapshotId)
        }
      })
      .catch((error: unknown) => {
        record.snapshot = {
          ...record.snapshot,
          error: `Runner cleanup failed: ${asErrorMessage(error)}`,
          updatedAt: this.deps.timestamp()
        }
        this.emitSnapshot(record)
      })
    record.closePromise = closePromise
    this.pendingResourceCloses.add(closePromise)
    void closePromise.finally(() => this.pendingResourceCloses.delete(closePromise))
  }
  private scheduleIdleTimer(record: AgentRecord): void {
    this.clearIdleTimer(record)
    const timer =
      this.deps.setTimer?.(() => {
        record.idleTimer = undefined
        if (record.snapshot.state !== 'idle' || this.closing) return
        this.setState(record, 'closed')
        this.startRunnerClose(record)
      }, this.idleTtlMs) ??
      setTimeout(() => {
        record.idleTimer = undefined
        if (record.snapshot.state !== 'idle' || this.closing) return
        this.setState(record, 'closed')
        this.startRunnerClose(record)
      }, this.idleTtlMs)
    record.idleTimer = timer
    const maybeUnref = timer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
  }

  private clearIdleTimer(record: AgentRecord): void {
    if (record.idleTimer === undefined) return
    if (this.deps.clearTimer) {
      this.deps.clearTimer(record.idleTimer)
    } else {
      clearTimeout(record.idleTimer)
    }
    record.idleTimer = undefined
  }

  private setState(record: AgentRecord, state: SubagentState): void {
    if (record.snapshot.state === state) return
    record.snapshot = {
      ...record.snapshot,
      state,
      currentTurnId: state === 'running' ? record.snapshot.currentTurnId : undefined,
      ...(state === 'running' ? { error: undefined } : {}),
      updatedAt: this.deps.timestamp()
    }
    this.emitSnapshot(record)
  }

  private hasPendingMessages(agentId: string): boolean {
    return (this.agents.get(agentId)?.mailbox.length ?? 0) > 0
  }

  private appendProgress(agentId: string, chunk: string): void {
    if (!chunk) return
    const record = this.agents.get(agentId)
    if (!record) return
    const progress = `${record.snapshot.progress ?? ''}${chunk}`
    record.snapshot = {
      ...record.snapshot,
      progress:
        progress.length > MAX_TASK_PROGRESS_LENGTH
          ? progress.slice(-MAX_TASK_PROGRESS_LENGTH)
          : progress,
      updatedAt: this.deps.timestamp()
    }
  }
  private nextParentSequence(threadId: string): number {
    const sequence = this.parentSequences.get(threadId) ?? 1
    this.parentSequences.set(threadId, sequence + 1)
    return sequence
  }

  private emitSnapshot(record: AgentRecord): void {
    const snapshot = cloneSnapshot(record.snapshot)
    const event: SubagentUpdatedEvent = {
      type: 'subagent.updated',
      eventId: this.deps.createId(),
      timestamp: this.deps.timestamp(),
      threadId: snapshot.parentThreadId,
      runId: snapshot.launchRunId,
      ...(snapshot.requestMessageId ? { requestMessageId: snapshot.requestMessageId } : {}),
      agentId: snapshot.agentId,
      launchRunId: snapshot.launchRunId,
      ...(snapshot.currentTurnId ? { turnId: snapshot.currentTurnId } : {}),
      snapshot
    }
    this.deps.onSnapshot?.(snapshot)
    this.deps.emit(event)
  }
  private emitSnapshotReady(record: AgentRecord, snapshotId: string): void {
    const snapshot = cloneSnapshot(record.snapshot)
    const event: SubagentSnapshotReadyEvent = {
      type: 'subagent.snapshot.ready',
      eventId: this.deps.createId(),
      timestamp: this.deps.timestamp(),
      threadId: snapshot.parentThreadId,
      runId: snapshot.launchRunId,
      ...(snapshot.requestMessageId ? { requestMessageId: snapshot.requestMessageId } : {}),
      agentId: snapshot.agentId,
      launchRunId: snapshot.launchRunId,
      snapshot,
      snapshotId
    }
    this.deps.emit(event)
  }

  private emitProgress(input: LaunchSubagentInput, turnId: string, chunk: string): void {
    if (!chunk) return
    const event: SubagentProgressEvent = {
      type: 'subagent.progress',
      eventId: this.deps.createId(),
      timestamp: this.deps.timestamp(),
      threadId: input.parentThreadId,
      runId: input.launchRunId,
      ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
      delegationId: input.agentId,
      agentId: input.agentId,
      turnId,
      launchRunId: input.launchRunId,
      chunk
    }
    this.deps.emit(event)
  }

  private emitToolCall(
    input: LaunchSubagentInput,
    eventInput: Parameters<SubagentRunnerFactoryInput['onToolCall']>[0]
  ): void {
    const event: SubagentToolCallEvent = {
      type: 'subagent.toolCall',
      eventId: this.deps.createId(),
      timestamp: this.deps.timestamp(),
      threadId: input.parentThreadId,
      runId: input.launchRunId,
      ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
      delegationId: input.agentId,
      agentId: input.agentId,
      turnId: eventInput.turnId,
      launchRunId: input.launchRunId,
      ...(eventInput.toolCallId ? { toolCallId: eventInput.toolCallId } : {}),
      toolName: eventInput.toolName,
      inputSummary: eventInput.inputSummary,
      ...(eventInput.outputSummary ? { outputSummary: eventInput.outputSummary } : {}),
      ...(eventInput.status ? { status: eventInput.status } : {})
    }
    this.deps.emit(event)
  }

  private emitMessage(record: AgentRecord, envelope: AgentMessageEnvelope): void {
    const event = {
      type: 'subagent.message' as const,
      eventId: this.deps.createId(),
      timestamp: this.deps.timestamp(),
      threadId: record.launch.parentThreadId,
      runId: record.launch.launchRunId,
      ...(record.launch.requestMessageId
        ? { requestMessageId: record.launch.requestMessageId }
        : {}),
      agentId: record.launch.agentId,
      launchRunId: record.launch.launchRunId,
      envelope
    }
    this.deps.emit(event)
  }
}
