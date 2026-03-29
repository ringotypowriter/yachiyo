import { tool } from 'ai'
import { z } from 'zod'
import { CronExpressionParser } from 'cron-parser'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

import type {
  ScheduleRecord,
  ScheduleResultStatus,
  ThreadRecord,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../storage/storage.ts'

export interface ScheduleServerApi {
  createThread(input: {
    source?: ThreadRecord['source']
    workspacePath?: string
    title?: string
  }): Promise<ThreadRecord>
  setThreadModelOverride(input: {
    threadId: string
    modelOverride: NonNullable<ThreadRecord['modelOverride']>
  }): Promise<ThreadRecord>
  sendChat(input: {
    threadId: string
    content: string
    enabledTools?: string[]
    extraTools?: Record<string, unknown>
    channelHint?: string
  }): Promise<{ runId: string }>
  setThreadIcon(input: { threadId: string; icon: string }): Promise<ThreadRecord>
  archiveThread(input: { threadId: string }): Promise<void>
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
}

export interface ScheduleServiceDeps {
  server: ScheduleServerApi
  storage: Pick<
    YachiyoStorage,
    | 'listSchedules'
    | 'getSchedule'
    | 'createScheduleRun'
    | 'completeScheduleRun'
    | 'recoverInterruptedScheduleRuns'
  >
  createId: () => string
  timestamp: () => string
  tempWorkspaceDir: string
}

interface ScheduleTimer {
  timeout: ReturnType<typeof setTimeout>
  scheduleId: string
}

/** Interval for polling the DB to pick up CLI-originated schedule changes. */
const SYNC_INTERVAL_MS = 60_000

/**
 * Node's setTimeout uses a 32-bit signed integer for the delay, so anything
 * above ~24.8 days (2^31 - 1 ms) silently overflows and fires almost immediately.
 * We cap long delays and re-arm in smaller steps until we reach the real fire time.
 */
const MAX_TIMEOUT_MS = 2_147_483_647

const SCHEDULE_ICONS = ['⏰', '🕐', '📋', '🗓️', '⚡', '🔄', '🤖', '📌', '🎯', '✨']

function pickScheduleIcon(): string {
  return SCHEDULE_ICONS[Math.floor(Math.random() * SCHEDULE_ICONS.length)]
}

const SCHEDULE_CHANNEL_HINT = `This is an automated scheduled task. When you have completed the task, you MUST call the \`reportScheduleResult\` tool exactly once with:
- status: 'success' if the task was completed, 'failure' if it could not be completed
- summary: a brief description of what was accomplished or what went wrong

Do not end your response without calling reportScheduleResult.`

export interface ScheduleService {
  start(): void
  stop(): void
  reload(): void
}

/** Build a fingerprint string from the schedule set so we can detect DB-level changes. */
function scheduleFingerprint(schedules: ScheduleRecord[]): string {
  return schedules
    .map((s) => `${s.id}:${s.enabled ? '1' : '0'}:${s.cronExpression}:${s.updatedAt}`)
    .sort()
    .join('|')
}

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const timers = new Map<string, ScheduleTimer>()
  const activeRuns = new Set<string>()
  let syncTimer: ReturnType<typeof setInterval> | null = null
  let lastFingerprint = ''

  function armTimer(schedule: ScheduleRecord): void {
    clearTimer(schedule.id)

    if (!schedule.enabled) return

    try {
      const cron = CronExpressionParser.parse(schedule.cronExpression, {
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
      const next = cron.next()
      const fireAt = next.getTime()

      armTimerAt(schedule.id, fireAt)
    } catch (err) {
      console.error(`[schedule] failed to arm timer for "${schedule.name}":`, err)
    }
  }

  /** Arm (or re-arm) a timer toward `fireAt`, chunking long delays to stay within 32-bit range. */
  function armTimerAt(scheduleId: string, fireAt: number): void {
    const delayMs = fireAt - Date.now()
    if (delayMs < 0) return

    const clampedDelay = Math.min(delayMs, MAX_TIMEOUT_MS)
    const timeout = setTimeout(() => {
      if (fireAt - Date.now() > 100) {
        // Still not time yet — re-arm for the remaining span.
        armTimerAt(scheduleId, fireAt)
      } else {
        void fireSchedule(scheduleId)
      }
    }, clampedDelay)

    timers.set(scheduleId, { timeout, scheduleId })
  }

  function clearTimer(scheduleId: string): void {
    const existing = timers.get(scheduleId)
    if (existing) {
      clearTimeout(existing.timeout)
      timers.delete(scheduleId)
    }
  }

  function clearAllTimers(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer.timeout)
    }
    timers.clear()
  }

  async function fireSchedule(scheduleId: string): Promise<void> {
    const schedule = deps.storage.getSchedule(scheduleId)
    if (!schedule || !schedule.enabled) return

    if (activeRuns.has(scheduleId)) {
      console.warn(`[schedule] skipping overlapping fire for "${schedule.name}"`)
      armTimer(schedule)
      return
    }

    activeRuns.add(scheduleId)
    const runId = deps.createId()
    const startedAt = deps.timestamp()

    // Persist the run record immediately so every execution — including early
    // setup failures (bad workspace, thread creation error) — is visible in
    // the schedule history UI/CLI. The threadId is backfilled once available.
    deps.storage.createScheduleRun({
      id: runId,
      scheduleId,
      status: 'running',
      startedAt
    })

    let capturedResult: { status: ScheduleResultStatus; summary: string } | undefined
    let threadId: string | undefined

    try {
      // Resolve workspace
      const workspacePath =
        schedule.workspacePath ?? join(deps.tempWorkspaceDir, `schedule-${schedule.id}`)
      await mkdir(workspacePath, { recursive: true })

      // Create thread as first-party local — NOT as an external channel source.
      // Using 'local' ensures scheduled runs get full memory recall, unsandboxed
      // tools, and normal thread treatment (not guest/external-channel code paths).
      // The schedule origin is tracked via schedule_runs.threadId FK and the title.
      const thread = await deps.server.createThread({
        source: 'local',
        workspacePath,
        title: `Schedule: ${schedule.name}`
      })

      threadId = thread.id
      await deps.server.setThreadIcon({ threadId, icon: pickScheduleIcon() })

      // Backfill the threadId now that the thread exists.
      deps.storage.completeScheduleRun({
        id: runId,
        status: 'running',
        completedAt: startedAt,
        threadId
      })

      // Apply model override
      if (schedule.modelOverride) {
        await deps.server.setThreadModelOverride({
          threadId: thread.id,
          modelOverride: schedule.modelOverride
        })
      }

      // Build report tool closure
      const reportScheduleResult = tool({
        description:
          'Report the result of this scheduled task. You MUST call this exactly once when done.',
        inputSchema: z.object({
          status: z.enum(['success', 'failure']),
          summary: z.string().describe('Brief summary of what was accomplished or what went wrong.')
        }),
        execute: async ({ status, summary }) => {
          capturedResult = { status, summary }
          return `Schedule result recorded: ${status}`
        }
      })

      // Subscribe to events to detect run completion.
      // Handle completed, failed, AND cancelled as terminal states so the
      // schedule is never stuck waiting on a promise that never resolves.
      const { promise, resolve } = Promise.withResolvers<{
        status: 'completed' | 'failed'
        error?: string
        promptTokens?: number
        completionTokens?: number
      }>()

      const unsubscribe = deps.server.subscribe((event: YachiyoServerEvent) => {
        if ('threadId' in event && event.threadId !== thread.id) return

        if (event.type === 'run.completed') {
          unsubscribe()
          resolve({
            status: 'completed',
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens
          })
        } else if (event.type === 'run.failed') {
          unsubscribe()
          resolve({ status: 'failed', error: event.error })
        } else if (event.type === 'run.cancelled') {
          unsubscribe()
          resolve({ status: 'failed', error: 'Run was cancelled.' })
        }
      })

      // Send the prompt
      await deps.server.sendChat({
        threadId: thread.id,
        content: schedule.prompt,
        enabledTools: schedule.enabledTools,
        extraTools: { reportScheduleResult },
        channelHint: SCHEDULE_CHANNEL_HINT
      })

      // Wait for completion
      const result = await promise

      // Record result
      deps.storage.completeScheduleRun({
        id: runId,
        status: result.status,
        resultStatus: capturedResult?.status,
        resultSummary: capturedResult?.summary,
        error: result.error,
        completedAt: deps.timestamp(),
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens
      })

      console.log(
        `[schedule] "${schedule.name}" ${result.status}` +
          (capturedResult ? `: ${capturedResult.status} — ${capturedResult.summary}` : '')
      )
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error(`[schedule] "${schedule.name}" execution error:`, errorMessage)

      deps.storage.completeScheduleRun({
        id: runId,
        status: 'failed',
        error: errorMessage,
        completedAt: deps.timestamp()
      })
    } finally {
      // Auto-archive the schedule thread to keep the sidebar clean.
      // Archive does not touch the workspace path.
      // Defer archival so the runDomain's follow-up and cleanup logic
      // (which runs in the same event-loop turn) can finish first.
      if (threadId) {
        const tid = threadId
        setTimeout(() => {
          void deps.server.archiveThread({ threadId: tid }).catch(() => {
            // Thread may already be archived or deleted — not critical.
          })
        }, 500)
      }

      activeRuns.delete(scheduleId)
      // Re-arm for next fire
      const fresh = deps.storage.getSchedule(scheduleId)
      if (fresh) armTimer(fresh)
    }
  }

  function loadAndArm(): void {
    clearAllTimers()
    const schedules = deps.storage.listSchedules()
    lastFingerprint = scheduleFingerprint(schedules)
    for (const schedule of schedules) {
      armTimer(schedule)
    }
    return undefined
  }

  /** Poll the DB for changes made outside of IPC (e.g. CLI mutations). */
  function syncFromDb(): void {
    const schedules = deps.storage.listSchedules()
    const fp = scheduleFingerprint(schedules)
    if (fp !== lastFingerprint) {
      console.log('[schedule] detected external change, reloading')
      lastFingerprint = fp
      clearAllTimers()
      for (const schedule of schedules) {
        armTimer(schedule)
      }
    }
  }

  return {
    start() {
      // Recover interrupted runs from previous session
      deps.storage.recoverInterruptedScheduleRuns({
        completedAt: deps.timestamp(),
        error: 'Interrupted by app restart.'
      })

      loadAndArm()
      syncTimer = setInterval(syncFromDb, SYNC_INTERVAL_MS)
      console.log(
        `[schedule] started with ${lastFingerprint.split('|').filter(Boolean).length} schedule(s)`
      )
    },

    stop() {
      if (syncTimer) {
        clearInterval(syncTimer)
        syncTimer = null
      }
      clearAllTimers()
      console.log('[schedule] stopped')
    },

    reload() {
      loadAndArm()
      console.log(
        `[schedule] reloaded ${lastFingerprint.split('|').filter(Boolean).length} schedule(s)`
      )
    }
  }
}
