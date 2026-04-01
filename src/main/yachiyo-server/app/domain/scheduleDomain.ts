import { CronExpressionParser } from 'cron-parser'

import type {
  CreateScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  UpdateScheduleInput
} from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'

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

  listSchedules(): ScheduleRecord[] {
    return this.storage.listSchedules()
  }

  getSchedule(id: string): ScheduleRecord {
    const schedule = this.storage.getSchedule(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    return schedule
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

function validateCronExpression(expression: string): void {
  try {
    CronExpressionParser.parse(expression.trim())
  } catch {
    throw new Error(`Invalid cron expression: "${expression}"`)
  }
}
