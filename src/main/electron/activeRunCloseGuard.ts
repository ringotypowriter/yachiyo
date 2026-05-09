import electron from 'electron'

const { dialog } = electron

export const STOP_ACTIVE_RUN_AND_CLOSE_RESPONSE = 0
const CANCEL_CLOSE_RESPONSE = 1

export interface ActiveRunCloseGuardDependencies {
  cancelActiveRuns: () => Promise<void> | void
  isBypassed: () => boolean
  listActiveRunIds: () => readonly string[]
  platform: NodeJS.Platform
  showMessageBox?: (
    window: Electron.BrowserWindow,
    options: Electron.MessageBoxOptions
  ) => Promise<{ response: number }>
}

export function shouldGuardActiveRunClose(input: {
  activeRunCount: number
  isBypassed: boolean
  platform: NodeJS.Platform
}): boolean {
  return input.platform === 'darwin' && !input.isBypassed && input.activeRunCount > 0
}

export function createActiveRunCloseDialogOptions(
  activeRunCount: number
): Electron.MessageBoxOptions {
  if (!Number.isInteger(activeRunCount) || activeRunCount < 1) {
    throw new Error('activeRunCount must be a positive integer')
  }

  const singleRun = activeRunCount === 1
  return {
    type: 'warning',
    title: 'Active run in progress',
    message: singleRun ? 'A run is still active.' : `${activeRunCount} runs are still active.`,
    detail: singleRun
      ? 'Stop the run and close this window?'
      : 'Stop the active runs and close this window?',
    buttons: ['Stop Run and Close', 'Cancel'],
    defaultId: CANCEL_CLOSE_RESPONSE,
    cancelId: CANCEL_CLOSE_RESPONSE,
    noLink: true
  }
}

export function installActiveRunCloseGuard(
  window: Electron.BrowserWindow,
  dependencies: ActiveRunCloseGuardDependencies
): void {
  const showMessageBox =
    dependencies.showMessageBox ??
    ((targetWindow: Electron.BrowserWindow, options: Electron.MessageBoxOptions) =>
      dialog.showMessageBox(targetWindow, options))
  let confirmationInFlight = false
  let allowConfirmedClose = false

  window.on('close', (event) => {
    if (allowConfirmedClose) {
      allowConfirmedClose = false
      return
    }

    const activeRunIds = dependencies.listActiveRunIds()
    const shouldGuard = shouldGuardActiveRunClose({
      activeRunCount: activeRunIds.length,
      isBypassed: dependencies.isBypassed(),
      platform: dependencies.platform
    })
    if (!shouldGuard) return

    event.preventDefault()
    if (confirmationInFlight) return
    confirmationInFlight = true

    void (async () => {
      try {
        const result = await showMessageBox(
          window,
          createActiveRunCloseDialogOptions(activeRunIds.length)
        )
        if (result.response !== STOP_ACTIVE_RUN_AND_CLOSE_RESPONSE) return

        await dependencies.cancelActiveRuns()
        if (window.isDestroyed()) return

        allowConfirmedClose = true
        window.close()
      } catch (error) {
        console.error('[active-run-close-guard] failed to handle close confirmation', error)
      } finally {
        confirmationInFlight = false
      }
    })()
  })
}
