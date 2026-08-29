import type { ThreadRecord } from '@yachiyo/shared/protocol'
import type { BackgroundBashTaskResult } from '../../background/backgroundBashManager.ts'
import { getCompletedBackgroundBashError } from '../tools/backgroundBashToolResult.ts'

export function buildBackgroundCompletionMessage(result: BackgroundBashTaskResult): string {
  const error = getCompletedBackgroundBashError(result)
  return (
    `[Background task ${error ? 'failed' : 'completed'}]\n` +
    `Task ID: ${result.taskId}\n` +
    `Command: ${result.command}\n` +
    (result.exitCode !== undefined ? `Exit code: ${result.exitCode}\n` : '') +
    (error ? `Error: ${error}\n` : '') +
    (result.pid != null ? `Process PID: ${result.pid}\n` : '') +
    `Log file: ${result.logPath}\n\n` +
    (error
      ? `The background command failed. You can read the log file for available output.`
      : `The background command has finished. You can read the log file for full output.`)
  )
}

export function isBackgroundAutoDeliveryEligible(
  thread: ThreadRecord,
  getChannelUser: (channelUserId: string) => { role?: string } | undefined
): boolean {
  const source = thread.source
  if (source == null || source === 'local') return true
  if (thread.channelGroupId) return false
  if (!thread.channelUserId) return false
  const user = getChannelUser(thread.channelUserId)
  return user?.role === 'owner'
}
