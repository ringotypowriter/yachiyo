interface BackgroundTaskPresentationInput {
  exitCode?: number
  error?: string
  logTail: string[]
}

export type BackgroundTaskFailureSummary =
  | { kind: 'exit-code'; exitCode: number }
  | { kind: 'error'; message: string }
  | { kind: 'unknown' }

export function getBackgroundTaskFailureSummary(
  task: BackgroundTaskPresentationInput
): BackgroundTaskFailureSummary {
  if (task.exitCode !== undefined) {
    return { kind: 'exit-code', exitCode: task.exitCode }
  }

  const message = task.error?.trim()
  return message ? { kind: 'error', message } : { kind: 'unknown' }
}

export function getBackgroundTaskLogContent(
  task: BackgroundTaskPresentationInput,
  loadedContent: string
): string {
  return loadedContent || task.logTail.join('\n') || task.error?.trim() || ''
}
