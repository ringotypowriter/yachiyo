import assert from 'node:assert/strict'
import test from 'node:test'

import { ActivityTracker, type ActivityTrackerDeps } from './ActivityTracker.ts'

function createTrackerDeps(): ActivityTrackerDeps & {
  intervals: Array<{ callback: () => void; ms: number; active: boolean }>
  setNow: (value: number) => void
} {
  let now = 1_000
  const intervals: Array<{ callback: () => void; ms: number; active: boolean }> = []

  return {
    intervals,
    setNow(value: number): void {
      now = value
    },
    now: () => now,
    sampleActivity: async () => ({
      appName: 'Zed',
      bundleId: 'dev.zed.Zed'
    }),
    checkAccessibilityPermission: async () => true,
    setInterval(callback, ms) {
      const entry = { callback, ms, active: true }
      intervals.push(entry)
      return entry as unknown as ReturnType<typeof setInterval>
    },
    clearInterval(timer) {
      ;(timer as unknown as { active: boolean }).active = false
    }
  }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

test('ActivityTracker resets an empty tracking session when consumed', async () => {
  const deps = createTrackerDeps()
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    assert.equal(deps.intervals.length, 1)

    assert.equal(tracker.finalizeAndConsume(), null)

    deps.setNow(5_000)
    tracker.handleWindowBlur()
    assert.equal(deps.intervals.length, 2)
    deps.intervals[1].callback()
    await flushAsyncWork()

    deps.setNow(8_000)
    const summary = tracker.finalizeAndConsume()

    assert.equal(summary?.totalDurationMs, 3_000)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker does not start polling after focus returns during full-mode permission check', async () => {
  let resolvePermission: (value: boolean) => void = () => {}
  const deps = createTrackerDeps()
  deps.checkAccessibilityPermission = () =>
    new Promise<boolean>((resolve) => {
      resolvePermission = resolve
    })
  const tracker = new ActivityTracker('full', deps)

  try {
    tracker.handleWindowBlur()
    tracker.handleWindowFocus()
    resolvePermission(true)
    await flushAsyncWork()

    assert.equal(deps.intervals.length, 0)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker rechecks full-mode permission after mode is selected again', async () => {
  const deps = createTrackerDeps()
  let checks = 0
  deps.checkAccessibilityPermission = async () => {
    checks += 1
    return checks > 1
  }
  const tracker = new ActivityTracker('full', deps)

  try {
    tracker.handleWindowBlur()
    await flushAsyncWork()
    assert.equal(deps.intervals.length, 1)
    tracker.handleWindowFocus()

    tracker.setMode('full')
    tracker.handleWindowBlur()
    await flushAsyncWork()

    assert.equal(checks, 2)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker closes the open span at the current time before summarizing', async () => {
  const deps = createTrackerDeps()
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(4_000)
    tracker.handleWindowFocus()

    const summary = tracker.finalizeAndConsume()
    assert.match(summary?.text ?? '', /Zed.*3s/)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker allows only one in-flight sample at a time', async () => {
  const deps = createTrackerDeps()
  let sampleCalls = 0
  let resolveSample: (
    sample: Awaited<ReturnType<ActivityTrackerDeps['sampleActivity']>>
  ) => void = () => {}
  deps.sampleActivity = () => {
    sampleCalls += 1
    return new Promise((resolve) => {
      resolveSample = resolve
    })
  }
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    deps.intervals[0].callback()

    assert.equal(sampleCalls, 1)

    resolveSample({ appName: 'Zed', bundleId: 'dev.zed.Zed' })
    await flushAsyncWork()
    deps.intervals[0].callback()

    assert.equal(sampleCalls, 2)
  } finally {
    tracker.finalizeAndConsume()
  }
})
