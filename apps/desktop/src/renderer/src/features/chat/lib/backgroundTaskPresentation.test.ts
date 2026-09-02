import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getBackgroundTaskFailureSummary,
  getBackgroundTaskLogContent
} from './backgroundTaskPresentation.ts'

const FAILED_TASK = {
  status: 'failed' as const,
  error: 'Failed to launch process: executable not found',
  logTail: [] as string[]
}

test('failed background task uses its error as the summary when no exit code exists', () => {
  assert.deepEqual(getBackgroundTaskFailureSummary(FAILED_TASK), {
    kind: 'error',
    message: 'Failed to launch process: executable not found'
  })
})

test('failed background task keeps an available exit code as the summary status', () => {
  assert.deepEqual(getBackgroundTaskFailureSummary({ ...FAILED_TASK, exitCode: 127 }), {
    kind: 'exit-code',
    exitCode: 127
  })
})

test('background task error is shown as expanded log content when no log exists', () => {
  assert.equal(
    getBackgroundTaskLogContent(FAILED_TASK, ''),
    'Failed to launch process: executable not found'
  )
})

test('background task log content takes precedence over the error fallback', () => {
  assert.equal(getBackgroundTaskLogContent(FAILED_TASK, 'process output'), 'process output')
})
