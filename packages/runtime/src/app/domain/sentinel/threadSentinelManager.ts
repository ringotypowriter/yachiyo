import type { ToolSet } from 'ai'
import type { ThreadSentinelRecord, ThreadSentinelUpdatedEvent } from '@yachiyo/shared/protocol'
import type {
  ComposerReasoningSelection,
  RunModeId,
  SendChatRunTrigger,
  ToolCallName
} from '@yachiyo/shared/protocol'
import type { EmitServerEvent } from '../shared/shared.ts'

export interface ThreadSentinelWakeContext {
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
  runMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
  runTrigger?: SendChatRunTrigger
  channelHint?: string
  extraTools?: ToolSet
}

export interface SetThreadSentinelInput {
  threadId: string
  goal: string
  stopCondition: string
  intervalMinutes: number
  wakeContext?: ThreadSentinelWakeContext
}

export interface ThreadSentinelWakeInput {
  threadId: string
  content: string
  wakeContext?: ThreadSentinelWakeContext
}

export interface ThreadSentinelManagerDeps {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (timer: unknown) => void
  emit: EmitServerEvent
  wakeThread: (input: ThreadSentinelWakeInput) => Promise<void>
}

interface StoredSentinel {
  state: ThreadSentinelRecord
  wakeContext?: ThreadSentinelWakeContext
  timer?: unknown
}

export interface ThreadSentinelManager {
  set(input: SetThreadSentinelInput): ThreadSentinelRecord
  clear(threadId: string): boolean
  get(threadId: string): ThreadSentinelRecord | undefined
  list(): ThreadSentinelRecord[]
  onRunTerminal(threadId: string): void
  dispose(): void
}

export function createThreadSentinelManager(
  deps: ThreadSentinelManagerDeps
): ThreadSentinelManager {
  const sentinels = new Map<string, StoredSentinel>()

  const emitUpdated = (threadId: string, sentinel?: ThreadSentinelRecord): void => {
    deps.emit<ThreadSentinelUpdatedEvent>({
      type: 'thread.sentinel.updated',
      threadId,
      ...(sentinel ? { sentinel } : {})
    })
  }

  const cancelTimer = (entry: StoredSentinel): void => {
    if (entry.timer !== undefined) {
      deps.clearTimer(entry.timer)
      delete entry.timer
    }
  }

  const scheduleNextWake = (entry: StoredSentinel): void => {
    cancelTimer(entry)
    const nextRunAtMs = deps.now() + entry.state.intervalMinutes * 60_000
    entry.state = {
      ...entry.state,
      nextRunAt: new Date(nextRunAtMs).toISOString()
    }
    entry.timer = deps.setTimer(
      () => {
        void wake(entry.state.threadId).catch(() => {})
      },
      Math.max(0, nextRunAtMs - deps.now())
    )
    emitUpdated(entry.state.threadId, entry.state)
  }

  const wake = async (threadId: string): Promise<void> => {
    const entry = sentinels.get(threadId)
    if (!entry) return

    cancelTimer(entry)
    entry.state = { ...entry.state }
    delete entry.state.nextRunAt
    emitUpdated(threadId, entry.state)

    await deps.wakeThread({
      threadId,
      content: buildSentinelWakePrompt(entry.state),
      ...(entry.wakeContext ? { wakeContext: entry.wakeContext } : {})
    })
  }

  return {
    set(input) {
      if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1) {
        throw new Error('Sentinel interval must be at least 1 minute.')
      }

      const existing = sentinels.get(input.threadId)
      if (existing) cancelTimer(existing)

      const state: ThreadSentinelRecord = {
        threadId: input.threadId,
        goal: input.goal,
        stopCondition: input.stopCondition,
        intervalMinutes: input.intervalMinutes,
        updatedAt: new Date(deps.now()).toISOString()
      }
      sentinels.set(input.threadId, {
        state,
        ...(input.wakeContext ? { wakeContext: cloneWakeContext(input.wakeContext) } : {})
      })
      emitUpdated(input.threadId, state)
      return state
    },

    clear(threadId) {
      const existing = sentinels.get(threadId)
      if (!existing) return false
      cancelTimer(existing)
      sentinels.delete(threadId)
      emitUpdated(threadId)
      return true
    },

    get(threadId) {
      return sentinels.get(threadId)?.state
    },

    list() {
      return Array.from(sentinels.values(), (entry) => entry.state)
    },

    onRunTerminal(threadId) {
      const entry = sentinels.get(threadId)
      if (!entry) return
      scheduleNextWake(entry)
    },

    dispose() {
      for (const entry of sentinels.values()) {
        cancelTimer(entry)
      }
      sentinels.clear()
    }
  }
}

function cloneWakeContext(context: ThreadSentinelWakeContext): ThreadSentinelWakeContext {
  return {
    ...(context.enabledTools ? { enabledTools: [...context.enabledTools] } : {}),
    ...(context.enabledSkillNames ? { enabledSkillNames: [...context.enabledSkillNames] } : {}),
    ...(context.runMode ? { runMode: context.runMode } : {}),
    ...(context.reasoningEffort ? { reasoningEffort: context.reasoningEffort } : {}),
    ...(context.runTrigger ? { runTrigger: context.runTrigger } : {}),
    ...(context.channelHint ? { channelHint: context.channelHint } : {}),
    ...(context.extraTools ? { extraTools: context.extraTools } : {})
  }
}

function buildSentinelWakePrompt(sentinel: ThreadSentinelRecord): string {
  return `Automatic check for this conversation\n\nGoal: ${sentinel.goal}\n\nStop condition: ${sentinel.stopCondition}\n\nEvaluate the current state against the stop condition. If it is satisfied, call useSentinel with action "clear". If it is not satisfied, continue the work needed for the goal and do not call useSentinel again — the next check will be scheduled automatically after this run ends.`
}
