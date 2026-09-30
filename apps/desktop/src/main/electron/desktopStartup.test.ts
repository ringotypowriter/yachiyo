import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'
import {
  DesktopNativeDependencyError,
  desktopStartupFailureOptions,
  reportDesktopStartupFailure,
  verifyNativeSqliteDependency
} from './desktopStartup.ts'

test('native SQLite preflight closes its temporary database', () => {
  let closed = false
  verifyNativeSqliteDependency(() => ({
    close: () => {
      closed = true
    }
  }))
  assert.equal(closed, true)
})

test('native SQLite preflight preserves the loader failure as a typed cause', () => {
  const cause = new Error('Missing binding')
  assert.throws(
    () =>
      verifyNativeSqliteDependency(() => {
        throw cause
      }),
    (error: unknown) => error instanceof DesktopNativeDependencyError && error.cause === cause
  )
})

test('startup diagnostics distinguish secure storage and source/package native failures', () => {
  const secureStore = new ProviderCredentialStoreUnavailableError('unavailable')
  const native = new DesktopNativeDependencyError(new Error('wrong ABI'))
  const linux = desktopStartupFailureOptions(secureStore, 'linux', false)
  const mac = desktopStartupFailureOptions(secureStore, 'darwin', false)
  const packaged = desktopStartupFailureOptions(native, 'linux', true)
  const source = desktopStartupFailureOptions(native, 'linux', false)
  assert.notEqual(linux.detail, mac.detail)
  assert.notEqual(packaged.detail, source.detail)
  assert.notEqual(linux.detail, source.detail)
})

test('startup failure logs the original error, waits for dismissal, then quits', async () => {
  const error = new Error('private diagnostic data')
  const events: unknown[] = []
  const dismissal = Promise.withResolvers<void>()
  const pending = reportDesktopStartupFailure(error, {
    platform: 'linux',
    isPackaged: false,
    logError: (value) => events.push(value),
    showMessageBox: async (options) => {
      events.push('dialog')
      assert.equal(JSON.stringify(options).includes(error.message), false)
      await dismissal.promise
    },
    quit: () => events.push('quit')
  })
  assert.deepEqual(events, [error, 'dialog'])
  dismissal.resolve()
  await pending
  assert.deepEqual(events, [error, 'dialog', 'quit'])
})

test('startup failure still exits if the desktop cannot show the diagnostic dialog', async () => {
  const error = new Error('startup')
  const dialogError = new Error('display unavailable')
  const events: unknown[] = []
  await reportDesktopStartupFailure(error, {
    platform: 'linux',
    isPackaged: false,
    logError: (value) => events.push(value),
    showMessageBox: async () => {
      throw dialogError
    },
    quit: () => events.push('quit')
  })
  assert.deepEqual(events, [error, dialogError, 'quit'])
})
