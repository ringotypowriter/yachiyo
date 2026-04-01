import type {
  CreateScheduleInput,
  ScheduleRecord,
  ThreadModelOverride,
  UpdateScheduleInput
} from '../../../shared/yachiyo/protocol'

export interface ScheduleFormSubmitValues {
  initial?: ScheduleRecord
  mode: 'recurring' | 'one-off'
  name: string
  /** Present when mode is 'recurring'. */
  cron: string
  /** Present when mode is 'one-off'. ISO 8601 datetime string. */
  runAt: string
  prompt: string
  modelOverride?: ThreadModelOverride
  workspacePath?: string
}

export type ScheduleFormSubmitInput = Omit<UpdateScheduleInput, 'id'> &
  Pick<CreateScheduleInput, 'name' | 'prompt'>

export type ScheduleFormSubmitResult =
  | { ok: true; input: ScheduleFormSubmitInput }
  | { ok: false; error: string }

export function buildScheduleFormSubmitInput(
  values: ScheduleFormSubmitValues
): ScheduleFormSubmitResult {
  const name = values.name.trim()
  const prompt = values.prompt.trim()
  const cron = values.cron.trim()
  const runAt = values.runAt.trim()
  const isEdit = Boolean(values.initial)

  if (!name || !prompt) {
    return { ok: false, error: 'All fields are required.' }
  }

  if (values.mode === 'one-off') {
    if (isNaN(Date.parse(runAt.replace(' ', 'T')))) {
      return { ok: false, error: 'Invalid date/time for one-off schedule.' }
    }
    return {
      ok: true,
      input: {
        name,
        cronExpression: isEdit ? null : undefined,
        runAt: new Date(runAt.replace(' ', 'T')).toISOString(),
        prompt,
        modelOverride: values.modelOverride ?? (isEdit ? null : undefined),
        workspacePath: values.workspacePath ?? (isEdit ? null : undefined)
      }
    }
  }

  if (!cron) {
    return { ok: false, error: 'All fields are required.' }
  }

  return {
    ok: true,
    input: {
      name,
      cronExpression: cron,
      runAt: isEdit ? null : undefined,
      prompt,
      modelOverride: values.modelOverride ?? (isEdit ? null : undefined),
      workspacePath: values.workspacePath ?? (isEdit ? null : undefined)
    }
  }
}
