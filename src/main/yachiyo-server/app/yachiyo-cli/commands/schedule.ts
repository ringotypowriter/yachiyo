import { randomUUID } from 'node:crypto'
import type {
  CreateScheduleInput,
  UpdateScheduleInput
} from '../../../../../shared/yachiyo/protocol.ts'
import { ScheduleDomain } from '../../domain/scheduleDomain.ts'
import { namespaceHelp } from '../core/help.ts'
import { outputJson, sanitizeForOutput } from '../core/output.ts'

export async function handleScheduleCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('schedule')}\n`)
    return
  }

  const { createSqliteYachiyoStorage } = await import('../../../storage/sqlite/database.ts')
  const storage = createSqliteYachiyoStorage(dbPath)
  const domain = new ScheduleDomain({
    storage,
    createId: () => randomUUID(),
    timestamp: () => new Date().toISOString()
  })
  domain.ensureBundledSchedules()

  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'

  if (action === 'list') {
    const schedules = domain.listSchedules()
    if (useJson) {
      outputJson(stdout, schedules)
    } else {
      for (const s of schedules) {
        const scheduleLabel = s.runAt ? `@${s.runAt}` : (s.cronExpression ?? '?')
        const bundledTag = s.bundled ? ' [bundled]' : ''
        stdout.write(
          `${s.enabled ? '✓' : '✗'} ${s.name} [${scheduleLabel}]${bundledTag} id=${s.id}\n`
        )
      }
      if (schedules.length === 0) stdout.write('No schedules.\n')
    }
    storage.close()
    return
  }

  if (action === 'add') {
    const payloadRaw = flags.get('--payload')
    if (!payloadRaw) throw new Error('--payload is required for schedule add')
    const input = JSON.parse(payloadRaw) as CreateScheduleInput
    const schedule = domain.createSchedule(input)
    outputJson(stdout, sanitizeForOutput(schedule))
    storage.close()
    return
  }

  if (action === 'update') {
    const payloadRaw = flags.get('--payload')
    if (!payloadRaw) throw new Error('--payload is required for schedule update')
    const input = JSON.parse(payloadRaw) as UpdateScheduleInput
    if (!input.id) throw new Error('Payload must include id for schedule update')
    const schedule = domain.updateSchedule(input)
    outputJson(stdout, sanitizeForOutput(schedule))
    storage.close()
    return
  }

  if (action === 'remove') {
    const id = positionals[1]
    if (!id) throw new Error('ID is required: schedule remove <id>')
    domain.deleteSchedule(id)
    stdout.write(`Deleted schedule: ${id}\n`)
    storage.close()
    return
  }

  if (action === 'enable') {
    const id = positionals[1]
    if (!id) throw new Error('ID is required: schedule enable <id>')
    domain.enableSchedule(id)
    stdout.write(`Enabled schedule: ${id}\n`)
    storage.close()
    return
  }

  if (action === 'disable') {
    const id = positionals[1]
    if (!id) throw new Error('ID is required: schedule disable <id>')
    domain.disableSchedule(id)
    stdout.write(`Disabled schedule: ${id}\n`)
    storage.close()
    return
  }

  if (action === 'runs') {
    const scheduleId = positionals[1]
    const limitRaw = flags.get('--limit')
    const limit = limitRaw ? parseInt(limitRaw, 10) : 20
    const runs = scheduleId
      ? domain.listScheduleRuns(scheduleId, limit)
      : domain.listRecentScheduleRuns(limit)

    if (useJson) {
      outputJson(stdout, runs)
    } else {
      for (const r of runs) {
        const status = r.resultStatus ?? r.status
        const summary = r.resultSummary ? ` — ${r.resultSummary.slice(0, 80)}` : ''
        stdout.write(`[${status}] ${r.startedAt}${summary}\n`)
      }
      if (runs.length === 0) stdout.write('No runs.\n')
    }
    storage.close()
    return
  }

  storage.close()
  throw new Error(
    `Unknown schedule action: ${action ?? '(none)'}. Expected: list, add, update, remove, enable, disable, runs`
  )
}
