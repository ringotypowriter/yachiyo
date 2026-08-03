import { formatAppUpdateBlockedError, type AppUpdateInstallResult } from '@yachiyo/shared/appUpdate'

import type { AppUpdateController } from '../electron/appUpdateController.ts'
import type { AppUpdateCommandInput, AppUpdateCommandReply } from './commandSocket.ts'

export function createAppUpdateCommandHandler(input: {
  controller: AppUpdateController
  getRunningVersion: () => string
  getActiveRunIds: () => string[]
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
    const reservation = input.controller.reservePreparedInstall()
    const result: AppUpdateInstallResult = {
      state: 'installing',
      interruptedRunCount: summary.interruptedRunCount,
      initiatorRunInterrupted: summary.initiatorRunActive
    }
    return {
      result,
      afterReply: () => reservation.install(),
      onReplyFailure: () => reservation.release()
    }
  }
}
