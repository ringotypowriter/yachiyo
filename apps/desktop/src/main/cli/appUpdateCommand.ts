import { randomUUID } from 'node:crypto'

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
  receipt?: Omit<
    InstallReceiptDeps,
    'reserve' | 'release' | 'fromVersion' | 'targetVersion' | 'attemptId'
  > & {
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
    // A fresh id per install attempt, so a contender that loses the
    // reservation race cannot clear the winner's pending receipt.
    const attemptId = randomUUID()
    let reservation: AppUpdateInstallReservation | undefined
    const receipt = input.receipt
    await runInstallReceiptSequence(command.initiatorRunId, {
      resolveOrigin: receipt?.resolveOrigin ?? (async () => ({ kind: 'no-channel' as const })),
      persist: receipt?.persist ?? (() => {}),
      clear: receipt?.clear ?? (() => {}),
      announce: receipt?.announce ?? (async () => {}),
      announceTimeoutMs: receipt?.announceTimeoutMs ?? 2_000,
      now: receipt?.now ?? (() => Date.now()),
      // A fresh id per install attempt, so a contender that loses the
      // reservation race cannot clear the winner's pending receipt.
      attemptId,
      fromVersion: input.getRunningVersion(),
      targetVersion: receipt?.targetVersion() ?? '',
      reserve: () => {
        reservation = input.controller.reservePreparedInstall()
      },
      release: () => {
        reservation?.release()
        reservation = undefined
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
      // Both of these mean the same thing to the user: we said we were
      // going and we are not. The socket finalizer routes an afterReply
      // throw to onError rather than to onReplyFailure, so the withdrawal
      // has to happen here — relying on onReplyFailure alone left the
      // promise standing whenever the install itself threw.
      afterReply: () => {
        try {
          claimed.install()
        } catch (error) {
          receipt?.clear(attemptId)
          throw error
        }
      },
      onReplyFailure: () => {
        claimed.release()
        // We already told the user we were going; that promise has to be
        // withdrawn, or the pending record reports a restart that never came.
        receipt?.clear(attemptId)
      }
    }
  }
}
