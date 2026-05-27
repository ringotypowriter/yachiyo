import type { ThreadModelOverride, ToolCallName } from '../protocol.ts'

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface ScheduleRecord {
  id: string
  name: string
  /** Cron expression for recurring schedules. Exactly one of cronExpression or runAt must be set. */
  cronExpression?: string
  /** ISO datetime for one-off schedules. The schedule is disabled after it fires or is skipped. */
  runAt?: string
  prompt: string
  workspacePath?: string
  modelOverride?: ThreadModelOverride
  enabledTools?: ToolCallName[]
  enabled: boolean
  /** True for schedules shipped with Yachiyo. Bundled schedules can be disabled but not deleted. */
  bundled?: boolean
  createdAt: string
  updatedAt: string
}

export type ScheduleRunStatus = 'running' | 'completed' | 'failed' | 'skipped'
export type ScheduleResultStatus = 'success' | 'failure'

export interface ScheduleRunRecord {
  id: string
  scheduleId: string
  threadId?: string
  status: ScheduleRunStatus
  resultStatus?: ScheduleResultStatus
  resultSummary?: string
  error?: string
  promptTokens?: number
  completionTokens?: number
  startedAt: string
  completedAt?: string
}

export interface CreateScheduleInput {
  name: string
  /** Cron expression for recurring schedules. Exactly one of cronExpression or runAt must be provided. */
  cronExpression?: string
  /** ISO datetime for a one-off schedule. Exactly one of cronExpression or runAt must be provided. */
  runAt?: string
  prompt: string
  workspacePath?: string
  modelOverride?: ThreadModelOverride
  enabledTools?: ToolCallName[]
  enabled?: boolean
}

export interface UpdateScheduleInput {
  id: string
  name?: string
  /** Pass null to clear and switch to one-off mode (requires also setting runAt). */
  cronExpression?: string | null
  /** Pass null to clear and switch to recurring mode (requires also setting cronExpression). */
  runAt?: string | null
  prompt?: string
  workspacePath?: string | null
  modelOverride?: ThreadModelOverride | null
  enabledTools?: ToolCallName[] | null
  enabled?: boolean
}

// ── Translator ──────────────────────────────────────────────────────
