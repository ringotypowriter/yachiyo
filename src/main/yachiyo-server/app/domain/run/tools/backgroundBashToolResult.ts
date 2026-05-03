import type {
  BashToolCallDetails,
  ToolCallRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { BackgroundBashTaskResult } from '../../backgroundBashManager.ts'

function isBashToolCallDetails(details: ToolCallRecord['details']): details is BashToolCallDetails {
  return (
    details != null &&
    typeof details === 'object' &&
    'command' in details &&
    typeof details.command === 'string' &&
    'cwd' in details &&
    typeof details.cwd === 'string' &&
    'stdout' in details &&
    typeof details.stdout === 'string' &&
    'stderr' in details &&
    typeof details.stderr === 'string'
  )
}

function getTerminalBashExitCode(details: unknown): number | undefined {
  if (details == null || typeof details !== 'object' || !('exitCode' in details)) {
    return undefined
  }
  return typeof details.exitCode === 'number' ? details.exitCode : undefined
}

function getTerminalBashCancelledByUser(details: unknown): true | undefined {
  if (details == null || typeof details !== 'object' || !('cancelledByUser' in details)) {
    return undefined
  }
  return details.cancelledByUser === true ? true : undefined
}

function getBackgroundBashTaskId(details: ToolCallRecord['details']): string | undefined {
  if (details == null || typeof details !== 'object' || !('taskId' in details)) {
    return undefined
  }
  return typeof details.taskId === 'string' && details.taskId.trim() ? details.taskId : undefined
}

export function mergeBackgroundBashDetails(input: {
  launchDetails: ToolCallRecord['details']
  terminalDetails: unknown
}): ToolCallRecord['details'] {
  if (!isBashToolCallDetails(input.launchDetails)) {
    return input.launchDetails
  }

  const terminalExitCode = getTerminalBashExitCode(input.terminalDetails)
  const terminalCancelledByUser = getTerminalBashCancelledByUser(input.terminalDetails)
  const merged: BashToolCallDetails & { cancelledByUser?: true } = {
    ...input.launchDetails,
    ...(terminalExitCode !== undefined ? { exitCode: terminalExitCode } : {}),
    ...(terminalCancelledByUser ? { cancelledByUser: true } : {})
  }
  return merged
}

export function getCompletedBackgroundBashStatus(
  task: BackgroundBashTaskResult
): Extract<ToolCallRecord['status'], 'completed' | 'failed'> {
  return task.cancelledByUser === true || task.exitCode !== 0 ? 'failed' : 'completed'
}

export function getCompletedBackgroundBashOutputSummary(task: BackgroundBashTaskResult): string {
  return task.cancelledByUser === true ? 'cancelled by user' : `exit ${task.exitCode}`
}

export function getCompletedBackgroundBashError(
  task: BackgroundBashTaskResult
): string | undefined {
  if (task.cancelledByUser === true) {
    return 'Background task was cancelled by the user.'
  }
  return task.exitCode !== 0 ? `Command exited with code ${task.exitCode}.` : undefined
}

export function resolveCompletedBackgroundBashTask(
  getCompletedBackgroundBashTask:
    | ((taskId: string) => BackgroundBashTaskResult | undefined)
    | undefined,
  input: {
    details: ToolCallRecord['details']
    threadId: string
    toolCallId: string
  }
): BackgroundBashTaskResult | undefined {
  const taskId = getBackgroundBashTaskId(input.details)
  if (!taskId) return undefined

  const task = getCompletedBackgroundBashTask?.(taskId)
  if (!task || task.threadId !== input.threadId) {
    return undefined
  }
  if (task.toolCallId && task.toolCallId !== input.toolCallId) {
    return undefined
  }
  return task
}
