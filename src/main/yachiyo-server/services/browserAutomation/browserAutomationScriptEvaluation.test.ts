import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeBrowserAutomationScriptExecutionError,
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
