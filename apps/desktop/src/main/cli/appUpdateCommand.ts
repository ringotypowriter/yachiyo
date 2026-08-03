import { formatAppUpdateBlockedError, type AppUpdateInstallResult } from '@yachiyo/shared/appUpdate'

import {
  runInstallReceiptSequence,
  type InstallReceiptDeps
} from '../appUpdate/installReceiptSequence.ts'
import type {
  AppUpdateController,
  AppUpdateInstallReservation
} from '../electron/appUpdateController.ts'
import type { AppUpdateCommandInput, AppUpdateCommandReply } from './commandSocket.ts'

export function createAppUpdateCommandHandler(input: {
  controller: AppUpdateController
  getRunningVersion: () => string
  getActiveRunIds: () => string[]
  /**
   * Announcing the restart and remembering who to report back to. Absent in
   * tests that only exercise the update mechanism; when absent the install
   * behaves exactly as it did before this layer existed.
   */
  receipt?: Omit<InstallReceiptDeps, 'reserve' | 'fromVersion' | 'targetVersion'> & {
    targetVersion: () => string | undefined
  }
}): (command: AppUpdateCommandInput) => Promise<AppUpdateCommandReply> {
  const activeRunSummary = (
    initiatorRunId: string | undefined
  ): {
    blockingRunCount: number
    initiatorRunActive: boolean
    interruptedRunCount: number
  } => {
    const activeRunIds = input.getActiveRunIds()
    const initiatorRunActive = initiatorRunId !== undefined && activeRunIds.includes(initiatorRunId)
    return {
      blockingRunCount: activeRunIds.length - (initiatorRunActive ? 1 : 0),
      initiatorRunActive,
      interruptedRunCount: activeRunIds.length
    }
  }

  return async (command) => {
    if (command.action === 'snapshot') {
      return { result: { runningVersion: input.getRunningVersion() } }
    }
    if (command.action === 'status') {
      return { result: await input.controller.status() }
    }
    if (command.action === 'prepare') {
      const prepared = await input.controller.prepareApply()
      if (prepared.state === 'up-to-date') {
        return { result: prepared }
      }
      return {
        result: {
          ...prepared,
          ...activeRunSummary(command.initiatorRunId)
        }
      }
    }

    const summary = activeRunSummary(command.initiatorRunId)
    if (summary.blockingRunCount > 0 && command.force !== true) {
      throw new Error(formatAppUpdateBlockedError(summary))
    }
    // The reservation is taken inside the sequence, because the order of
    // persist / reserve / announce is the contract and lives in one place.
    let reservation: AppUpdateInstallReservation | undefined
    const receipt = input.receipt
    await runInstallReceiptSequence(command.initiatorRunId, {
      resolveOrigin: receipt?.resolveOrigin ?? (async () => undefined),
      persist: receipt?.persist ?? (() => {}),
      clear: receipt?.clear ?? (() => {}),
      announce: receipt?.announce ?? (async () => {}),
      announceTimeoutMs: receipt?.announceTimeoutMs ?? 2_000,
      now: receipt?.now ?? (() => Date.now()),
      fromVersion: input.getRunningVersion(),
      targetVersion: receipt?.targetVersion() ?? '',
      reserve: () => {
        reservation = input.controller.reservePreparedInstall()
      }
    })
    if (!reservation) {
      throw new Error('Update install reservation was not created.')
    }
    const claimed = reservation
    const result: AppUpdateInstallResult = {
      state: 'installing',
      interruptedRunCount: summary.interruptedRunCount,
      initiatorRunInterrupted: summary.initiatorRunActive
    }
    return {
      result,
      afterReply: () => claimed.install(),
      onReplyFailure: () => {
        claimed.release()
        // We already told the user we were going; that promise has to be
        // withdrawn, or the pending record reports a restart that never came.
        receipt?.clear()
      }
    }
  }
}
