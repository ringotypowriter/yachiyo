import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STOP_ACTIVE_RUN_AND_CLOSE_RESPONSE,
  createActiveRunCloseDialogOptions,
  installActiveRunCloseGuard,
  shouldGuardActiveRunClose
} from './activeRunCloseGuard.ts'

function createCloseEvent(): Electron.Event & { prevented: boolean } {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  } as Electron.Event & { prevented: boolean }
}

function createMockWindow(): {
  closeEvents: Array<Electron.Event & { prevented: boolean }>
  closeRequests: number
  emitClose: () => Electron.Event & { prevented: boolean }
  window: Electron.BrowserWindow
} {
  let closeListener: ((event: Electron.Event) => void) | null = null
  const closeEvents: Array<Electron.Event & { prevented: boolean }> = []
  const window = {
    on(eventName: string, listener: (event: Electron.Event) => void): void {
      if (eventName === 'close') closeListener = listener
    },
    isDestroyed: () => false,
    close() {
      mock.closeRequests++
      mock.emitClose()
    }
  } as unknown as Electron.BrowserWindow
  const mock = {
    closeEvents,
    closeRequests: 0,
    emitClose(): Electron.Event & { prevented: boolean } {
      const event = createCloseEvent()
      closeEvents.push(event)
      closeListener?.(event)
      return event
    },
    window
  }
  return mock
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('shouldGuardActiveRunClose only guards macOS user close attempts with active runs', () => {
  assert.equal(
    shouldGuardActiveRunClose({ activeRunCount: 1, isBypassed: false, platform: 'darwin' }),
    true
  )
  assert.equal(
    shouldGuardActiveRunClose({ activeRunCount: 0, isBypassed: false, platform: 'darwin' }),
    false
  )
  assert.equal(
    shouldGuardActiveRunClose({ activeRunCount: 1, isBypassed: true, platform: 'darwin' }),
    false
  )
  assert.equal(
    shouldGuardActiveRunClose({ activeRunCount: 1, isBypassed: false, platform: 'linux' }),
    false
  )
})

test('createActiveRunCloseDialogOptions names the destructive and cancel choices', () => {
  const options = createActiveRunCloseDialogOptions(1)

  assert.equal(options.type, 'warning')
  assert.equal(options.message, 'A run is still active.')
  assert.deepEqual(options.buttons, ['Stop Run and Close', 'Cancel'])
  assert.equal(options.defaultId, 1)
  assert.equal(options.cancelId, 1)
})

test('installActiveRunCloseGuard keeps the window open when the user cancels', async () => {
  const mock = createMockWindow()
  let cancelRequests = 0

  installActiveRunCloseGuard(mock.window, {
    cancelActiveRuns: () => {
      cancelRequests++
    },
    isBypassed: () => false,
    listActiveRunIds: () => ['run-1'],
    platform: 'darwin',
    showMessageBox: async () => ({ response: 1 })
  })

  const event = mock.emitClose()
  await flushPromises()

  assert.equal(event.prevented, true)
  assert.equal(cancelRequests, 0)
  assert.equal(mock.closeRequests, 0)
})

test('installActiveRunCloseGuard stops active runs and allows the confirmed close', async () => {
  const mock = createMockWindow()
  let cancelRequests = 0

  installActiveRunCloseGuard(mock.window, {
    cancelActiveRuns: () => {
      cancelRequests++
    },
    isBypassed: () => false,
    listActiveRunIds: () => ['run-1'],
    platform: 'darwin',
    showMessageBox: async () => ({ response: STOP_ACTIVE_RUN_AND_CLOSE_RESPONSE })
  })

  const firstClose = mock.emitClose()
  await flushPromises()

  assert.equal(firstClose.prevented, true)
  assert.equal(cancelRequests, 1)
  assert.equal(mock.closeRequests, 1)
  assert.equal(mock.closeEvents[1]?.prevented, false)
})
