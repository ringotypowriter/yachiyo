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
  runUpdaterOperation<T>(operation: () => Promise<T>): Promise<T>
  tryRunUpdaterOperation<T>(operation: () => Promise<T>): Promise<T> | undefined
  hasActiveInstallReservation(): boolean
  reservePreparedInstall(): AppUpdateInstallReservation
  /** What a reservation taken right now would install, if anything. */
  getPreparedVersion(): string | undefined
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
  let activeUpdaterOperationCount = 0
  let activeInstallReservation: symbol | undefined

  async function executeUpdaterOperation<T>(operation: () => Promise<T>): Promise<T> {
    activeUpdaterOperationCount += 1
    try {
      return await operation()
    } finally {
      activeUpdaterOperationCount -= 1
    }
  }

  function tryRunUpdaterOperation<T>(operation: () => Promise<T>): Promise<T> | undefined {
    if (activeInstallReservation) return undefined
    return executeUpdaterOperation(operation)
  }

  function runUpdaterOperation<T>(operation: () => Promise<T>): Promise<T> {
    const started = tryRunUpdaterOperation(operation)
    if (!started) {
      return Promise.reject(new Error('Update installation is already in progress.'))
    }
    return started
  }

  function assertDownloadedVersion(expectedVersion: string): void {
    if (dependencies.getDownloadedVersion() !== expectedVersion) {
      throw new Error('Downloaded update changed after preparation. Prepare the update again.')
    }
  }

  function assertNoInstallReservation(): void {
    if (activeInstallReservation) {
      throw new Error('Update installation is already in progress.')
    }
  }

  async function status(): Promise<AppUpdateStatusResult> {
    assertNoInstallReservation()
    const runningVersion = dependencies.getRunningVersion()
    const downloadedVersion = dependencies.getDownloadedVersion()
    if (downloadedVersion) {
      return {
        state: 'ready',
        runningVersion,
        targetVersion: downloadedVersion
      }
    }

    const result = await runUpdaterOperation(dependencies.checkForUpdates)
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
    if (activeUpdaterOperationCount > 0) {
      throw new Error('An updater operation is already in progress. Try installing again shortly.')
    }
    if (activeInstallReservation) {
      throw new Error('Update installation is already in progress.')
    }

    const reservedVersion = preparedVersion
    preparedVersion = undefined
    const reservationRevision = ++preparationRevision
    assertDownloadedVersion(reservedVersion)
    const reservationToken = Symbol('app-update-install-reservation')
    activeInstallReservation = reservationToken
    let active = true

    const clearInstallReservation = (): void => {
      if (activeInstallReservation === reservationToken) {
        activeInstallReservation = undefined
      }
    }

    return {
      install(): void {
        if (!active) {
          throw new Error('Update install reservation is no longer active.')
        }
        active = false
        try {
          assertDownloadedVersion(reservedVersion)
          dependencies.quitAndInstall()
        } catch (error) {
          clearInstallReservation()
          throw error
        }
      },
      release(): void {
        if (!active) return
        active = false
        clearInstallReservation()
        if (preparationRevision === reservationRevision && !preparedVersion) {
          preparedVersion = reservedVersion
        }
      }
    }
  }

  return {
    status,
    runUpdaterOperation,
    tryRunUpdaterOperation,
    hasActiveInstallReservation: () => activeInstallReservation !== undefined,
    async prepareApply(): Promise<AppUpdateControllerPrepareResult> {
      assertNoInstallReservation()
      const revision = ++preparationRevision
      preparedVersion = undefined
      const updateStatus = await status()
      if (updateStatus.state === 'up-to-date') {
        return { state: 'up-to-date', runningVersion: updateStatus.runningVersion }
      }

      const targetVersion = updateStatus.targetVersion

      if (updateStatus.state === 'available') {
        await runUpdaterOperation(dependencies.downloadUpdate)
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
    getPreparedVersion: () => preparedVersion,
    installPrepared(): void {
      reservePreparedInstall().install()
    }
  }
}
