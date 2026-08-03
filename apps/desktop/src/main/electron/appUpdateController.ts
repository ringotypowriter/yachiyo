import type { AppUpdateStatusResult } from '@yachiyo/shared/appUpdate'

export interface AppUpdateCheckResult {
  available: boolean
  version: string
}

export interface AppUpdateControllerDependencies {
  getRunningVersion(): string
  getDownloadedVersion(): string | undefined
  checkForUpdates(): Promise<AppUpdateCheckResult>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
}

export type AppUpdateControllerPrepareResult =
  | {
      state: 'restart-required'
      runningVersion: string
      targetVersion: string
    }
  | {
      state: 'up-to-date'
      runningVersion: string
    }

export interface AppUpdateController {
  status(): Promise<AppUpdateStatusResult>
  prepareApply(): Promise<AppUpdateControllerPrepareResult>
  installPrepared(): void
}

export function createAppUpdateController(
  dependencies: AppUpdateControllerDependencies
): AppUpdateController {
  let preparedVersion: string | undefined

  async function status(): Promise<AppUpdateStatusResult> {
    const runningVersion = dependencies.getRunningVersion()
    const downloadedVersion = dependencies.getDownloadedVersion()
    if (downloadedVersion) {
      return {
        state: 'ready',
        runningVersion,
        targetVersion: downloadedVersion
      }
    }

    const result = await dependencies.checkForUpdates()
    if (!result.available) {
      return { state: 'up-to-date', runningVersion }
    }

    return {
      state: 'available',
      runningVersion,
      targetVersion: result.version
    }
  }

  return {
    status,
    async prepareApply(): Promise<AppUpdateControllerPrepareResult> {
      preparedVersion = undefined
      const updateStatus = await status()
      if (updateStatus.state === 'up-to-date') {
        return { state: 'up-to-date', runningVersion: updateStatus.runningVersion }
      }

      const targetVersion = updateStatus.targetVersion

      if (updateStatus.state === 'available') {
        await dependencies.downloadUpdate()
      }

      preparedVersion = targetVersion
      return {
        state: 'restart-required',
        runningVersion: updateStatus.runningVersion,
        targetVersion
      }
    },
    installPrepared(): void {
      if (!preparedVersion) {
        throw new Error('Update is not prepared for installation.')
      }
      preparedVersion = undefined
      dependencies.quitAndInstall()
    }
  }
}
