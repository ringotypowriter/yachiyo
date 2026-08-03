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
    }
  | {
      state: 'up-to-date'
      runningVersion: string
    }

export type AppUpdateAction = 'status' | 'apply' | 'snapshot'

export interface AppUpdateCommandRequest {
  type: 'app-update'
  action: AppUpdateAction
}

export interface AppUpdateSnapshot {
  runningVersion: string
}

export type AppUpdateCommandResult =
  | AppUpdateStatusResult
  | AppUpdatePrepareResult
  | AppUpdateSnapshot

export type AppUpdateCommandResponse =
  | { ok: true; result: AppUpdateCommandResult }
  | { ok: false; error: string }
