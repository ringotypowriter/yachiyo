import test from 'node:test'
import assert from 'node:assert/strict'

import { restartForUpdate } from './updateRestart.ts'

test('restartForUpdate relaunches the app and exits cleanly', () => {
  const calls: Array<{ method: 'relaunch' | 'exit'; code?: number }> = []

  restartForUpdate({
    relaunch() {
      calls.push({ method: 'relaunch' })
    },
    exit(code?: number) {
      calls.push({ method: 'exit', code })
    }
  })

  assert.deepEqual(calls, [{ method: 'relaunch' }, { method: 'exit', code: 0 }])
})
