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
  archiveThread(input: { threadId: string; unread?: boolean }): Promise<void>
  showNotification(input: { title: string; body?: string }): void
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
}

export interface ScheduleServiceDeps {
  server: ScheduleServerApi
  storage: Pick<
    YachiyoStorage,
    | 'listSchedules'
    | 'getSchedule'
    | 'updateSchedule'
    | 'deleteSchedule'
    | 'createScheduleRun'
    | 'completeScheduleRun'
    | 'recoverInterruptedScheduleRuns'
    | 'listThreadMessages'
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

const CONNECTIVITY_RETRIES = 2
const CONNECTIVITY_RETRY_DELAY_MS = 1_000

/** Quick connectivity probe — resolves true if we can reach the internet. */
export async function hasInternetConnection(): Promise<boolean> {
  for (let attempt = 0; attempt <= CONNECTIVITY_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5_000)
      const res = await fetch('https://example.com', {
        method: 'HEAD',
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (res.ok) return true
    } catch {
      // Retry on network/timeout errors.
    }
    if (attempt < CONNECTIVITY_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, CONNECTIVITY_RETRY_DELAY_MS))
    }
  }
  return false
}

const SCHEDULE_ICONS = ['⏰', '🕐', '📋', '🗓️', '⚡', '🔄', '🤖', '📌', '🎯', '✨']

function pickScheduleIcon(): string {
  return SCHEDULE_ICONS[Math.floor(Math.random() * SCHEDULE_ICONS.length)]
}

const SCHEDULE_CHANNEL_HINT = `This is an automated scheduled task. When you have completed the task, you MUST call the \`reportScheduleResult\` tool exactly once with:
- status: 'success' if the task was completed, 'failure' if it could not be completed
- summary: a brief description of what was accomplished or what went wrong

Do not end your response without calling reportScheduleResult.`

/**
 * Some models do real work but forget to call `reportScheduleResult` before
 * ending their turn. When that happens we re-prompt them with this message
 * (up to MAX_REPORT_REMINDER_RETRIES times) so the run still produces a
 * structured result instead of an empty card.
 */
const MAX_REPORT_REMINDER_RETRIES = 3
const REPORT_REMINDER_PROMPT = `You completed your work but did not call the \`reportScheduleResult\` tool. You MUST call it now exactly once with:
- status: 'success' if the task was completed, 'failure' if it could not be completed
- summary: a brief description of what was accomplished or what went wrong

Do not perform any additional work — just call the tool to record your result.`

export interface ScheduleService {
  start(): void
  stop(): void
  reload(): void
  /** Manually fire a schedule now, bypassing the enabled check. */
  triggerScheduleNow(scheduleId: string): Promise<void>
}

/** Build a fingerprint string from the schedule set so we can detect DB-level changes. */
function scheduleFingerprint(schedules: ScheduleRecord[]): string {
  return schedules
    .map(
      (s) =>
        `${s.id}:${s.enabled ? '1' : '0'}:${s.cronExpression ?? ''}:${s.runAt ?? ''}:${s.updatedAt}`
    )
    .sort()
    .join('|')
}

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const timers = new Map<string, ScheduleTimer>()
  const activeRuns = new Set<string>()
  let syncTimer: ReturnType<typeof setInterval> | null = null
  let lastFingerprint = ''

  function disarmOneOffSchedule(scheduleId: string, reason: 'completed' | 'skipped'): void {
    clearTimer(scheduleId)

    const schedule = deps.storage.getSchedule(scheduleId)
    if (!schedule?.runAt) return
    if (!schedule.enabled) return

    deps.storage.updateSchedule({
      ...schedule,
      enabled: false,
      updatedAt: deps.timestamp()
    })
    console.log(`[schedule] one-off "${schedule.name}" ${reason} and disabled`)
  }

  function armTimer(schedule: ScheduleRecord): void {
    clearTimer(schedule.id)

    if (!schedule.enabled) return

    try {
      if (schedule.runAt) {
        // One-off: fire at the exact datetime
        const fireAt = Date.parse(schedule.runAt)
        if (isNaN(fireAt)) {
          console.error(`[schedule] invalid runAt for "${schedule.name}": ${schedule.runAt}`)
          return
        }
        if (fireAt <= Date.now()) {
          // Already past — skip and disable so it doesn't fire.
          disarmOneOffSchedule(schedule.id, 'skipped')
          return
        }
        armTimerAt(schedule.id, fireAt)
      } else if (schedule.cronExpression) {
        const cron = CronExpressionParser.parse(schedule.cronExpression, {
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
        const next = cron.next()
        armTimerAt(schedule.id, next.getTime())
      } else {
        console.error(`[schedule] "${schedule.name}" has neither cronExpression nor runAt`)
      }
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

  async function fireSchedule(scheduleId: string, opts?: { manual?: boolean }): Promise<void> {
    const schedule = deps.storage.getSchedule(scheduleId)
    if (!schedule) return
    if (!opts?.manual && !schedule.enabled) return

    if (activeRuns.has(scheduleId)) {
      console.warn(`[schedule] skipping overlapping fire for "${schedule.name}"`)
      if (!schedule.runAt) {
        armTimer(schedule)
      }
      return
    }

    // Check internet connectivity before committing resources to the run.
    if (!(await hasInternetConnection())) {
      const runId = deps.createId()
      const now = deps.timestamp()
      deps.storage.createScheduleRun({
        id: runId,
        scheduleId,
        status: 'skipped',
        startedAt: now
      })
      deps.storage.completeScheduleRun({
        id: runId,
        status: 'skipped',
        completedAt: now,
        error: 'No internet connection.'
      })
      console.log(`[schedule] "${schedule.name}" skipped — no internet connection`)
      deps.server.showNotification({
        title: `${schedule.name} — skipped`,
        body: 'No internet connection.'
      })
      const fresh = deps.storage.getSchedule(scheduleId)
      if (fresh?.runAt) {
        disarmOneOffSchedule(scheduleId, 'skipped')
      } else if (fresh) {
        armTimer(fresh)
      }
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

      // Run one chat turn and wait for it to reach a terminal state.
      // Handle completed, failed, AND cancelled so the promise always resolves.
      interface TurnOutcome {
        status: 'completed' | 'failed'
        error?: string
        promptTokens?: number
        completionTokens?: number
      }
      const runChatTurn = async (content: string): Promise<TurnOutcome> => {
        const { promise, resolve } = Promise.withResolvers<TurnOutcome>()
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
        await deps.server.sendChat({
          threadId: thread.id,
          content,
          enabledTools: schedule.enabledTools,
          extraTools: { reportScheduleResult },
          channelHint: SCHEDULE_CHANNEL_HINT
        })
        return promise
      }

      // Initial turn — kick off the actual scheduled prompt.
      let result = await runChatTurn(schedule.prompt)
      let totalPromptTokens: number | undefined = result.promptTokens
      let totalCompletionTokens: number | undefined = result.completionTokens

      // Reminder loop: if the model finished cleanly, produced real output,
      // but never called reportScheduleResult, nudge it to call the tool.
      // Skip retries when the run failed (broken machinery) or when there is
      // no assistant output at all (broken model — nagging won't help).
      for (let attempt = 0; attempt < MAX_REPORT_REMINDER_RETRIES; attempt++) {
        if (capturedResult) break
        if (result.status !== 'completed') break

        const hasAssistantOutput = deps.storage
          .listThreadMessages(thread.id)
          .some(
            (m) =>
              m.role === 'assistant' &&
              ((m.content?.trim().length ?? 0) > 0 ||
                (m.responseMessages && m.responseMessages.length > 0))
          )
        if (!hasAssistantOutput) break

        console.log(
          `[schedule] "${schedule.name}" missing reportScheduleResult — reminder ${attempt + 1}/${MAX_REPORT_REMINDER_RETRIES}`
        )
        result = await runChatTurn(REPORT_REMINDER_PROMPT)
        if (result.promptTokens !== undefined) {
          totalPromptTokens = (totalPromptTokens ?? 0) + result.promptTokens
        }
        if (result.completionTokens !== undefined) {
          totalCompletionTokens = (totalCompletionTokens ?? 0) + result.completionTokens
        }
      }

      // Record result
      deps.storage.completeScheduleRun({
        id: runId,
        status: result.status,
        resultStatus: capturedResult?.status,
        resultSummary: capturedResult?.summary,
        error: result.error,
        completedAt: deps.timestamp(),
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens
      })

      const resultLabel = capturedResult?.status ?? result.status
      console.log(
        `[schedule] "${schedule.name}" ${result.status}` +
          (capturedResult ? `: ${capturedResult.status} — ${capturedResult.summary}` : '')
      )

      deps.server.showNotification({
        title: `${schedule.name} — ${resultLabel}`,
        body: capturedResult?.summary ?? (result.error ? `Error: ${result.error}` : undefined)
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error(`[schedule] "${schedule.name}" execution error:`, errorMessage)

      deps.storage.completeScheduleRun({
        id: runId,
        status: 'failed',
        error: errorMessage,
        completedAt: deps.timestamp()
      })

      deps.server.showNotification({
        title: `${schedule.name} — failed`,
        body: errorMessage
      })
    } finally {
      // Auto-archive the schedule thread to keep the sidebar clean.
      // Archive does not touch the workspace path.
      // Defer archival so the runDomain's follow-up and cleanup logic
      // (which runs in the same event-loop turn) can finish first.
      if (threadId) {
        const tid = threadId
        setTimeout(() => {
          void deps.server.archiveThread({ threadId: tid, unread: true }).catch(() => {
            // Thread may already be archived or deleted — not critical.
          })
        }, 500)
      }

      activeRuns.delete(scheduleId)
      // One-off schedules fire once, then stay disabled so run history remains visible.
      const fresh = deps.storage.getSchedule(scheduleId)
      if (fresh) {
        if (fresh.runAt) {
          disarmOneOffSchedule(scheduleId, 'completed')
        } else {
          armTimer(fresh)
        }
      }
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
    },

    async triggerScheduleNow(scheduleId: string): Promise<void> {
      await fireSchedule(scheduleId, { manual: true })
    }
  }
}
