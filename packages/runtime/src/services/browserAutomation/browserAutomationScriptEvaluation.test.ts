import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeBrowserAutomationScriptExecutionError,
  wrapBrowserAutomationPageEvalScript,
  unwrapBrowserAutomationPageScriptResult,
  wrapBrowserAutomationPageScript
} from './browserAutomationScriptEvaluation.ts'

test('browser automation script wrapper reports the page error message', async () => {
  const wrappedScript = wrapBrowserAutomationPageScript(
    `(() => {
      throw new ReferenceError('CSS is not defined')
    })()`
  )

  const result = await Function(`return ${wrappedScript}`)()

  assert.throws(
    () =>
      unwrapBrowserAutomationPageScriptResult(result, {
        action: 'snapshot',
        session: 's1',
        url: 'https://example.com'
      }),
    /Browser snapshot script in session "s1" at https:\/\/example\.com failed: ReferenceError: CSS is not defined/
  )
})

test('browser automation execution errors do not surface Electron renderer-console fallback', () => {
  const error = normalizeBrowserAutomationScriptExecutionError(
    new Error(
      'Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.'
    ),
    { action: 'snapshot', session: 's1', url: 'https://example.com' }
  )

  assert.match(
    error.message,
    /Browser snapshot script in session "s1" at https:\/\/example\.com could not run/
  )
  assert.doesNotMatch(error.message, /renderer console/)
  assert.doesNotMatch(error.message, /Script failed to execute/)
})

test('browser automation eval wrapper executes JavaScript statements and returns explicit values', async () => {
  const host = globalThis as typeof globalThis & { __yachiyoBrowserEvalTestValue?: number }
  host.__yachiyoBrowserEvalTestValue = 39
  try {
    const wrappedScript = wrapBrowserAutomationPageEvalScript(`
      const value = globalThis.__yachiyoBrowserEvalTestValue
      return await Promise.resolve(value + 3)
    `)

    const result = await Function(`return ${wrappedScript}`)()

    assert.equal(
      unwrapBrowserAutomationPageScriptResult(result, {
        action: 'eval',
        session: 's1',
        url: 'https://example.com'
      }),
      42
    )
  } finally {
    delete host.__yachiyoBrowserEvalTestValue
  }
})

test('browser automation eval wrapper times out never-settling scripts', async () => {
  const wrapEvalWithTimeout = wrapBrowserAutomationPageEvalScript as (
    script: string,
    timeoutMs: number
  ) => string
  const wrappedScript = wrapEvalWithTimeout('await new Promise(() => {})', 5)

  const result = await Promise.race([
    Function(`return ${wrappedScript}`)(),
    new Promise((resolve) => setTimeout(() => resolve('still pending'), 50))
  ])

  assert.notEqual(result, 'still pending')
  assert.throws(
    () =>
      unwrapBrowserAutomationPageScriptResult(result, {
        action: 'eval',
        session: 's1',
        url: 'https://example.com'
      }),
    /Timed out after 5ms running browser eval script\./
  )
})
