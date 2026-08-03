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
  reservePreparedInstall(): AppUpdateInstallReservation
  installPrepared(): void
}

export interface AppUpdateInstallReservation {
  install(): void
  release(): void
}

export function createAppUpdateController(
  dependencies: AppUpdateControllerDependencies
): AppUpdateController {
  let preparedVersion: string | undefined
  let preparationRevision = 0

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

  function reservePreparedInstall(): AppUpdateInstallReservation {
    if (!preparedVersion) {
      throw new Error('Update is not prepared for installation.')
    }

    const reservedVersion = preparedVersion
    preparedVersion = undefined
    const reservationRevision = ++preparationRevision
    let active = true

    return {
      install(): void {
        if (!active) {
          throw new Error('Update install reservation is no longer active.')
        }
        active = false
        dependencies.quitAndInstall()
      },
      release(): void {
        if (!active) return
        active = false
        if (preparationRevision === reservationRevision && !preparedVersion) {
          preparedVersion = reservedVersion
        }
      }
    }
  }

  return {
    status,
    async prepareApply(): Promise<AppUpdateControllerPrepareResult> {
      const revision = ++preparationRevision
      preparedVersion = undefined
      const updateStatus = await status()
      if (updateStatus.state === 'up-to-date') {
        return { state: 'up-to-date', runningVersion: updateStatus.runningVersion }
      }

      const targetVersion = updateStatus.targetVersion

      if (updateStatus.state === 'available') {
        await dependencies.downloadUpdate()
      }

      if (revision !== preparationRevision) {
        throw new Error('Update preparation was superseded by a newer request.')
      }
      preparedVersion = targetVersion
      return {
        state: 'restart-required',
        runningVersion: updateStatus.runningVersion,
        targetVersion
      }
    },
    reservePreparedInstall,
    installPrepared(): void {
      reservePreparedInstall().install()
    }
  }
}
