import { CronExpressionParser } from 'cron-parser'

import type {
  CreateScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  UpdateScheduleInput
} from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import { BUNDLED_SCHEDULES, isBundledScheduleId } from './bundledSchedules.ts'

function validateRunAt(runAt: string): void {
  const ts = Date.parse(runAt)
  if (isNaN(ts)) throw new Error(`Invalid runAt datetime: "${runAt}"`)
}

export interface ScheduleDomainDeps {
  storage: Pick<
    YachiyoStorage,
    | 'listSchedules'
    | 'getSchedule'
    | 'createSchedule'
    | 'updateSchedule'
    | 'deleteSchedule'
    | 'listScheduleRuns'
    | 'listRecentScheduleRuns'
  >
  createId: () => string
  timestamp: () => string
}

export class ScheduleDomain {
  private readonly storage: ScheduleDomainDeps['storage']
  private readonly createId: () => string
  private readonly timestamp: () => string

  constructor(deps: ScheduleDomainDeps) {
    this.storage = deps.storage
    this.createId = deps.createId
    this.timestamp = deps.timestamp
  }

  /**
   * Ensure all bundled schedules exist in storage. Called on startup and upgrade.
   *
   * - If missing: creates with defaults (enabled, default cron).
   * - If present: refreshes prompt text (picks up code changes) but preserves
   *   the user's cron expression and enabled preference.
   */
  ensureBundledSchedules(): void {
    for (const spec of BUNDLED_SCHEDULES) {
      const existing = this.storage.getSchedule(spec.id)
      if (!existing) {
        const now = this.timestamp()
        const schedule: ScheduleRecord = {
          id: spec.id,
          name: spec.name,
          cronExpression: spec.cronExpression,
          prompt: spec.prompt,
          enabled: true,
          bundled: true,
          createdAt: now,
          updatedAt: now
        }
        this.storage.createSchedule(schedule)
        console.log(`[schedule] created bundled schedule: ${spec.name}`)
      } else {
        let needsUpdate = false
        const patched = { ...existing }

        // Refresh prompt & name from code — these are owned by the spec
        if (existing.prompt !== spec.prompt || existing.name !== spec.name) {
          patched.name = spec.name
          patched.prompt = spec.prompt
          needsUpdate = true
        }

        // Restore default recurrence if the schedule was converted to one-off
        // (runAt set, cronExpression cleared). Without this, the one-off fires
        // once, scheduleService disables it, and the bundled schedule is stuck
        // disabled forever.
        if (!existing.cronExpression) {
          patched.cronExpression = spec.cronExpression
          delete patched.runAt
          patched.enabled = true
          needsUpdate = true
          console.log(`[schedule] restored default cron for bundled schedule: ${spec.name}`)
        }

        if (needsUpdate) {
          patched.updatedAt = this.timestamp()
          this.storage.updateSchedule(patched)
          console.log(`[schedule] refreshed bundled schedule: ${spec.name}`)
        }
      }
    }
  }

  listSchedules(): ScheduleRecord[] {
    return this.storage.listSchedules().map(hydrateBundled)
  }

  getSchedule(id: string): ScheduleRecord {
    const schedule = this.storage.getSchedule(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    return hydrateBundled(schedule)
  }

  createSchedule(input: CreateScheduleInput): ScheduleRecord {
    const name = input.name.trim()
    if (!name) throw new Error('Schedule name must not be empty.')

    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('Schedule prompt must not be empty.')

    const hasCron = Boolean(input.cronExpression?.trim())
    const hasRunAt = Boolean(input.runAt?.trim())
    if (!hasCron && !hasRunAt) throw new Error('Either cronExpression or runAt must be provided.')
    if (hasCron && hasRunAt)
      throw new Error('Only one of cronExpression or runAt may be provided, not both.')

    if (hasCron) validateCronExpression(input.cronExpression!)
    if (hasRunAt) validateRunAt(input.runAt!)

    const now = this.timestamp()
    const schedule: ScheduleRecord = {
      id: this.createId(),
      name,
      ...(hasCron ? { cronExpression: input.cronExpression!.trim() } : {}),
      ...(hasRunAt ? { runAt: input.runAt!.trim() } : {}),
      prompt,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      ...(input.enabledTools ? { enabledTools: input.enabledTools } : {}),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now
    }

    this.storage.createSchedule(schedule)
    return schedule
  }

  updateSchedule(input: UpdateScheduleInput): ScheduleRecord {
    const existing = this.storage.getSchedule(input.id)
    if (!existing) throw new Error(`Schedule not found: ${input.id}`)

    // Bundled schedules: only `enabled` and `cronExpression` are user-editable.
    // Name and prompt are owned by the spec (refreshed on startup); converting
    // to one-off (runAt) would let scheduleService disable it permanently.
    if (isBundledScheduleId(input.id)) {
      if (input.name !== undefined) {
        throw new Error('Cannot change the name of a bundled schedule.')
      }
      if (input.prompt !== undefined) {
        throw new Error('Cannot change the prompt of a bundled schedule.')
      }
      if (input.runAt !== undefined) {
        throw new Error('Cannot convert a bundled schedule to one-off.')
      }
    }

    if (input.name !== undefined && !input.name.trim()) {
      throw new Error('Schedule name must not be empty.')
    }

    if (input.prompt !== undefined && !input.prompt.trim()) {
      throw new Error('Schedule prompt must not be empty.')
    }

    if (input.cronExpression != null && input.cronExpression.trim()) {
      validateCronExpression(input.cronExpression)
    }

    if (input.runAt != null && input.runAt.trim()) {
      validateRunAt(input.runAt)
    }

    const updated: ScheduleRecord = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: this.timestamp()
    }

    // cronExpression: null = clear, string = set, undefined = keep
    if (input.cronExpression === null) {
      delete updated.cronExpression
    } else if (input.cronExpression !== undefined) {
      updated.cronExpression = input.cronExpression.trim()
    }

    // runAt: null = clear, string = set, undefined = keep
    if (input.runAt === null) {
      delete updated.runAt
    } else if (input.runAt !== undefined) {
      updated.runAt = input.runAt.trim()
    }

    // Validate the resulting record still has exactly one scheduling mode
    const hasCron = Boolean(updated.cronExpression)
    const hasRunAt = Boolean(updated.runAt)
    if (!hasCron && !hasRunAt)
      throw new Error('Schedule must have either cronExpression or runAt after update.')
    if (hasCron && hasRunAt)
      throw new Error('Schedule cannot have both cronExpression and runAt after update.')

    // Handle nullable fields — null means clear, undefined means keep
    if (input.workspacePath === null) {
      delete updated.workspacePath
    } else if (input.workspacePath !== undefined) {
      updated.workspacePath = input.workspacePath
    }

    if (input.modelOverride === null) {
      delete updated.modelOverride
    } else if (input.modelOverride !== undefined) {
      updated.modelOverride = input.modelOverride
    }

    if (input.enabledTools === null) {
      delete updated.enabledTools
    } else if (input.enabledTools !== undefined) {
      updated.enabledTools = input.enabledTools
    }

    this.storage.updateSchedule(updated)
    return updated
  }

  deleteSchedule(id: string): void {
    const existing = this.storage.getSchedule(id)
    if (!existing) throw new Error(`Schedule not found: ${id}`)
    if (isBundledScheduleId(id)) {
      throw new Error('Bundled schedules cannot be deleted. Use disable instead.')
    }
    this.storage.deleteSchedule(id)
  }

  enableSchedule(id: string): boolean {
    const schedule = this.updateSchedule({ id, enabled: true })
    return schedule.enabled
  }

  disableSchedule(id: string): ScheduleRecord {
    return this.updateSchedule({ id, enabled: false })
  }

  listScheduleRuns(scheduleId: string, limit?: number): ScheduleRunRecord[] {
    return this.storage.listScheduleRuns(scheduleId, limit)
  }

  listRecentScheduleRuns(limit?: number): ScheduleRunRecord[] {
    return this.storage.listRecentScheduleRuns(limit)
  }
}

/** Tag a schedule record with `bundled: true` if its ID belongs to a bundled schedule. */
function hydrateBundled(schedule: ScheduleRecord): ScheduleRecord {
  if (isBundledScheduleId(schedule.id)) {
    return { ...schedule, bundled: true }
  }
  return schedule
}

function validateCronExpression(expression: string): void {
  try {
    CronExpressionParser.parse(expression.trim())
  } catch {
    throw new Error(`Invalid cron expression: "${expression}"`)
  }
}
