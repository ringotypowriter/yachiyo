export type AppUpdateTerminalState = 'available' | 'ready' | 'up-to-date'

export type AppUpdateStatusResult =
  | {
      state: 'available' | 'ready'
      runningVersion: string
      targetVersion: string
    }
  | {
      state: 'up-to-date'
      runningVersion: string
    }

export type AppUpdatePrepareResult =
  | {
      state: 'restart-required'
      runningVersion: string
      targetVersion: string
      interruptedRunCount: number
      blockingRunCount: number
      initiatorRunActive: boolean
    }
  | {
      state: 'up-to-date'
      runningVersion: string
    }

export type AppUpdateApplyResult =
  | {
      state: 'updated'
      previousVersion: string
      targetVersion: string
      runningVersion: string
      interruptedRunCount: number
      initiatorRunInterrupted: boolean
    }
  | {
      state: 'restart-started'
      previousVersion: string
      targetVersion: string
      interruptedRunCount: number
      initiatorRunInterrupted: boolean
    }
  | {
      state: 'up-to-date'
      runningVersion: string
    }

export interface AppUpdateInstallResult {
  state: 'installing'
  interruptedRunCount: number
  initiatorRunInterrupted: boolean
}

export type AppUpdateAction = 'status' | 'prepare' | 'install' | 'snapshot'

export interface AppUpdateCommandRequest {
  type: 'app-update'
  action: AppUpdateAction
  force?: boolean
  initiatorRunId?: string
}

export interface AppUpdateSnapshot {
  runningVersion: string
}

export type AppUpdateCommandResult =
  | AppUpdateStatusResult
  | AppUpdatePrepareResult
  | AppUpdateInstallResult
  | AppUpdateSnapshot

export type AppUpdateCommandResponse =
  | { ok: true; result: AppUpdateCommandResult }
  | { ok: false; error: string }

export function formatAppUpdateBlockedError(input: {
  blockingRunCount: number
  interruptedRunCount: number
  initiatorRunActive: boolean
}): string {
  const noun = input.blockingRunCount === 1 ? 'run' : 'runs'
  const activeDescription = input.initiatorRunActive
    ? `${input.blockingRunCount} other active Yachiyo ${noun} (${input.interruptedRunCount} including the initiating run)`
    : `${input.blockingRunCount} active Yachiyo ${noun}`
  return `${activeDescription} would be interrupted; update not installed. Wait for them to finish and retry, or use --force to interrupt them.`
}
