import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoYachiyoStorage, isDevelopmentDemoModeEnabled } from './demoMode.ts'

test('demo mode is gated to development even when enabled in config', () => {
  assert.equal(isDevelopmentDemoModeEnabled({}, true), false)
  assert.equal(isDevelopmentDemoModeEnabled({ general: { demoMode: true } }, false), false)
  assert.equal(isDevelopmentDemoModeEnabled({ general: { demoMode: true } }, true), true)
})

test('demo storage bootstraps screenshot-ready threads and schedules', () => {
  const storage = createDemoYachiyoStorage()

  const bootstrap = storage.bootstrap()
  const threadTitles = bootstrap.threads.map((thread) => thread.title)
  const schedules = storage.listSchedules()
  const recentRuns = storage.listRecentScheduleRuns()

  assert.deepEqual(threadTitles, [
    'Choose release note tone',
    'Delegate auth review to coding agents',
    'Update pricing docs from live source'
  ])
  assert.equal(schedules.length, 3)
  assert.ok(recentRuns.length >= 4)
  assert.ok(
    recentRuns.some((run) => run.resultSummary?.includes('README screenshots')),
    'expected a recent schedule run that references screenshot output'
  )
})
