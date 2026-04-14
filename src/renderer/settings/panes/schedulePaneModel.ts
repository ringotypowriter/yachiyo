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
  Partial<Pick<CreateScheduleInput, 'name' | 'prompt'>>

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
  const isBundledEdit = values.initial?.bundled === true

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
        ...(isBundledEdit ? {} : { name, prompt }),
        ...(isBundledEdit ? {} : { cronExpression: isEdit ? null : undefined }),
        runAt: new Date(runAt.replace(' ', 'T')).toISOString(),
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
      ...(isBundledEdit ? {} : { name, prompt }),
      cronExpression: cron,
      ...(isBundledEdit ? {} : { runAt: isEdit ? null : undefined }),
      modelOverride: values.modelOverride ?? (isEdit ? null : undefined),
      workspacePath: values.workspacePath ?? (isEdit ? null : undefined)
    }
  }
}
