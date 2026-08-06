import type { ReadPendingUpdateReceipt } from './pendingUpdateReceipt.ts'

export type UpdateOutcomeKind = 'updated' | 'not-completed' | 'unexpected-version' | 'unknown'

export interface UpdateOutcome {
  kind: UpdateOutcomeKind
  message: string
}

/**
 * Turn "what we intended" plus "what is actually running now" into the message
 * the user gets after a self-triggered update restart.
 *
 * Keyed on the *observed* running version rather than on an assumption that
 * the intended target is what got installed. A different build can land
 * between prepare and install, and reporting that as a plain failure would be
 * confidently wrong — the failure mode this whole layer exists to avoid.
 */
export function describeUpdateOutcome(
  receipt: ReadPendingUpdateReceipt,
  runningVersion: string
): UpdateOutcome {
  // Too old to tell a story about. Say so plainly instead of inferring an
  // outcome from a version number that may have changed for other reasons
  // (a manual update, a rollback) in the meantime.
  if (receipt.expired) {
    return {
      kind: 'unknown',
      message: `之前那次更新的结果我不确定了（当时是 ${receipt.fromVersion}，现在运行的是 ${runningVersion}）。需要的话我可以再查一次。`
    }
  }

  if (runningVersion === receipt.targetVersion) {
    return { kind: 'updated', message: `已更新到 ${runningVersion}，我回来了。` }
  }

  if (runningVersion === receipt.fromVersion) {
    return {
      kind: 'not-completed',
      message: `更新未完成，版本仍是 ${runningVersion}。要我再试一次吗？`
    }
  }

  return {
    kind: 'unexpected-version',
    message: `已更新到 ${runningVersion}，与预期的 ${receipt.targetVersion} 不同。`
  }
}
