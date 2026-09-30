import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DesktopNativeDependencyError,
  reportDesktopStartupFailure,
  prepareDesktopCredentialStorage,
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

test('startup failure logs the original error and quits without a UI dependency', () => {
  const error = new Error('startup')
  const events: unknown[] = []
  reportDesktopStartupFailure(error, {
    logError: (value) => events.push(value),
    quit: () => events.push('quit')
  })
  assert.deepEqual(events, [error, 'quit'])
})

test('startup failure still exits if logging fails', () => {
  let quit = false
  assert.throws(
    () =>
      reportDesktopStartupFailure(new Error('startup'), {
        logError: () => {
          throw new Error('log unavailable')
        },
        quit: () => {
          quit = true
        }
      }),
    /log unavailable/
  )
  assert.equal(quit, true)
})

test('credential selection uses the final shell-derived settings directory', () => {
  let settingsPath = '/default-home/config.toml'
  const prepared: string[] = []
  prepareDesktopCredentialStorage({
    hydrateEnvironment: () => {
      settingsPath = '/shell-home/config.toml'
    },
    resolveSettingsPath: () => settingsPath,
    prepareCredentials: (path) => {
      prepared.push(path)
    }
  })
  assert.deepEqual(prepared, ['/shell-home/config.toml'])
})
