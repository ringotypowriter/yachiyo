import assert from 'node:assert/strict'
import test from 'node:test'

import { ActivityTracker, type ActivityTrackerDeps } from './ActivityTracker.ts'

function createTrackerDeps(): ActivityTrackerDeps & {
  intervals: Array<{ callback: () => void; ms: number; active: boolean }>
  timeouts: Array<{ callback: () => void; ms: number; active: boolean }>
  setNow: (value: number) => void
  setIdleTimeMs: (value: number) => void
} {
  let now = 1_000
  let idleTimeMs = 0
  const intervals: Array<{ callback: () => void; ms: number; active: boolean }> = []
  const timeouts: Array<{ callback: () => void; ms: number; active: boolean }> = []

  return {
    intervals,
    timeouts,
    setNow(value: number): void {
      now = value
    },
    setIdleTimeMs(value: number): void {
      idleTimeMs = value
    },
    now: () => now,
    getIdleTimeMs: () => idleTimeMs,
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
    },
    setTimeout(callback, ms) {
      const entry = { callback, ms, active: true }
      timeouts.push(entry)
      return entry as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout(timer) {
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

test('ActivityTracker stops attributing the focused app once the user is AFK', async () => {
  const deps = createTrackerDeps()
  const tracker = new ActivityTracker('simple', deps)

  try {
    deps.setNow(0)
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(10 * 60_000)
    deps.setIdleTimeMs(6 * 60_000)
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(60 * 60_000)
    const summary = tracker.finalizeAndConsume()

    assert.equal(summary?.afkDurationMs, 56 * 60_000)
    assert.match(summary?.text ?? '', /"appName":"Zed".*"duration":"4min"/)
    assert.match(summary?.text ?? '', /"status":"afk".*"duration":"56min"/)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker returns no activity summary for an AFK-only session', async () => {
  const deps = createTrackerDeps()
  const tracker = new ActivityTracker('simple', deps)

  try {
    deps.setNow(0)
    tracker.handleWindowBlur()

    deps.setNow(10 * 60_000)
    deps.setIdleTimeMs(6 * 60_000)
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(60 * 60_000)
    assert.equal(tracker.finalizeAndConsume(), null)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker captures an initial OCR snapshot while Yachiyo stays blurred', async () => {
  const deps = createTrackerDeps()
  const capturedTriggers: string[] = []
  deps.captureOcrSnapshot = async (sample, trigger) => {
    capturedTriggers.push(trigger)
    return {
      id: 'snapshot-1',
      capturedAt: '2026-05-17T04:30:00.000Z',
      appName: sample.appName,
      bundleId: sample.bundleId,
      source: 'screen',
      trigger,
      ocr: {
        engine: 'apple-vision',
        revision: 3,
        confidence: 0.9,
        lineCount: 2,
        contentHash: 'sha256:abc',
        excerpt: 'Activity tracker OCR context',
        text: 'Activity tracker OCR context from the blurred app'
      }
    }
  }
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    assert.equal(deps.timeouts[0]?.ms, 30_000)
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(31_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    deps.setNow(35_000)
    const summary = tracker.finalizeAndConsume()

    assert.deepEqual(capturedTriggers, ['initial-blur'])
    assert.equal(summary?.snapshots?.length, 1)
    assert.match(summary?.text ?? '', /"ocrSnapshotCount":1/)
    assert.doesNotMatch(summary?.text ?? '', /Activity tracker OCR context/)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker cancels pending initial OCR when Yachiyo regains focus', async () => {
  const deps = createTrackerDeps()
  let captureCalls = 0
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    tracker.handleWindowFocus()

    assert.equal(deps.timeouts[0]?.active, false)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(captureCalls, 0)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker drops an OCR snapshot that finishes after Yachiyo regains focus', async () => {
  const deps = createTrackerDeps()
  let resolveCapture: (() => void) | undefined
  let captureStarted = false
  deps.captureOcrSnapshot = async (sample, trigger) => {
    captureStarted = true
    await new Promise<void>((resolve) => {
      resolveCapture = resolve
    })
    return {
      id: 'snapshot-1',
      capturedAt: '2026-05-17T04:30:00.000Z',
      appName: sample.appName,
      bundleId: sample.bundleId,
      source: 'screen',
      trigger,
      ocr: {
        engine: 'apple-vision',
        revision: 3,
        confidence: 0.9,
        lineCount: 1,
        contentHash: 'sha256:late',
        excerpt: 'Late OCR context',
        text: 'Late OCR context'
      }
    }
  }
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(31_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(captureStarted, true)
    tracker.handleWindowFocus()
    resolveCapture?.()
    await flushAsyncWork()

    deps.setNow(35_000)
    const summary = tracker.finalizeAndConsume()

    assert.equal(summary?.snapshots, undefined)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker skips OCR for private foreground apps', async () => {
  const deps = createTrackerDeps()
  let captureCalls = 0
  deps.sampleActivity = async () => ({ appName: '1Password', bundleId: 'com.1password.1password' })
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    deps.setNow(31_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(captureCalls, 0)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker does not OCR while the user is AFK', async () => {
  const deps = createTrackerDeps()
  let captureCalls = 0
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)

  try {
    tracker.handleWindowBlur()
    deps.setNow(31_000)
    deps.setIdleTimeMs(6 * 60_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(captureCalls, 0)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker closes AFK time at the last activity timestamp after the user returns', async () => {
  const deps = createTrackerDeps()
  const tracker = new ActivityTracker('simple', deps)

  try {
    deps.setNow(0)
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(10 * 60_000)
    deps.setIdleTimeMs(6 * 60_000)
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(20 * 60_000)
    deps.setIdleTimeMs(60_000)
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(21 * 60_000)
    deps.setIdleTimeMs(0)
    const summary = tracker.finalizeAndConsume()

    assert.equal(summary?.afkDurationMs, 15 * 60_000)
    assert.match(summary?.text ?? '', /"status":"afk".*"duration":"15min"/)
  } finally {
    tracker.finalizeAndConsume()
  }
})
