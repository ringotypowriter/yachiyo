import type { ThreadRecord } from '../../../../../../shared/yachiyo/protocol.ts'
import type { BackgroundBashTaskResult } from '../../backgroundBashManager.ts'

export function buildBackgroundCompletionMessage(result: BackgroundBashTaskResult): string {
  return (
    `[Background task completed]\n` +
    `Task ID: ${result.taskId}\n` +
    `Command: ${result.command}\n` +
    `Exit code: ${result.exitCode}\n` +
    `Log file: ${result.logPath}\n\n` +
    `The background command has finished. You can read the log file for full output.`
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
