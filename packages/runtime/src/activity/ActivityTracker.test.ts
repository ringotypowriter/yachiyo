import assert from 'node:assert/strict'
import test from 'node:test'

import type { ActivitySnapshot } from '@yachiyo/shared/protocol'
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
      appName: 'Example Editor',
      bundleId: 'com.example.editor'
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

type OcrCaptureProvider = NonNullable<ActivityTrackerDeps['captureOcrSnapshot']>
type OcrCaptureSample = Parameters<OcrCaptureProvider>[0]
type OcrCaptureTrigger = Parameters<OcrCaptureProvider>[1]

function makeOcrSnapshot(
  sample: OcrCaptureSample,
  trigger: OcrCaptureTrigger,
  id: string
): ActivitySnapshot {
  return {
    id,
    capturedAt: '2026-05-17T04:30:00.000Z',
    appName: sample.appName,
    bundleId: sample.bundleId,
    source: 'screen' as const,
    trigger,
    ocr: {
      engine: 'apple-vision' as const,
      revision: 3,
      confidence: 0.9,
      lineCount: 1,
      contentHash: `sha256:${id}`,
      excerpt: 'Example OCR context',
      text: 'Example OCR context'
    }
  }
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
    assert.match(summary?.text ?? '', /Example Editor.*3s/)
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

    resolveSample({ appName: 'Example Editor', bundleId: 'com.example.editor' })
    await flushAsyncWork()
    deps.intervals[0].callback()

    assert.equal(sampleCalls, 2)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker keeps foreground time while input is idle', async () => {
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

    assert.equal(summary?.entries[0].inputIdleDurationMs, 56 * 60_000)
    assert.match(summary?.text ?? '', /"appName":"Example Editor".*"duration":"60min"/)
    assert.match(summary?.text ?? '', /"inputIdleDuration":"56min"/)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker records a window even when the session starts input-idle', async () => {
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
    assert.equal(tracker.finalizeAndConsume()?.entries[0].durationMs, 50 * 60_000)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker does not OCR unless activity OCR is enabled', async () => {
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
    deps.timeouts[0]?.callback()
    await flushAsyncWork()

    assert.equal(captureCalls, 0)
    assert.equal(deps.timeouts.length, 0)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker skips OCR for apps excluded by the user', async () => {
  const deps = createTrackerDeps()
  let captureCalls = 0
  deps.sampleActivity = async () => ({ appName: 'Example Chat', bundleId: 'com.example.chat' })
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)
  tracker.setOcrConfig({ enabled: true, excludedApps: ['Example Chat'] })

  try {
    tracker.handleWindowBlur()
    deps.setNow(31_000)
    deps.timeouts[0]?.callback()
    await flushAsyncWork()

    assert.equal(captureCalls, 0)
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
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

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
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

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
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

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

test('ActivityTracker skips OCR if it is disabled while sampleActivity is pending', async () => {
  const deps = createTrackerDeps()
  let resolveSample: ((sample: OcrCaptureSample) => void) | undefined
  let sampleStarted = false
  let captureCalls = 0
  deps.sampleActivity = async () => {
    sampleStarted = true
    return new Promise((resolve) => {
      resolveSample = resolve
    })
  }
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

  try {
    tracker.handleWindowBlur()
    deps.setNow(31_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(sampleStarted, true)
    tracker.setOcrConfig({ enabled: false, excludedApps: [] })
    resolveSample?.({ appName: 'Example Editor', bundleId: 'com.example.editor' })
    await flushAsyncWork()

    assert.equal(captureCalls, 0)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker drops an OCR snapshot if OCR is disabled while capture is pending', async () => {
  const deps = createTrackerDeps()
  let resolveCapture: (() => void) | undefined
  let captureStarted = false
  deps.captureOcrSnapshot = async (sample, trigger) => {
    captureStarted = true
    await new Promise<void>((resolve) => {
      resolveCapture = resolve
    })
    return makeOcrSnapshot(sample, trigger, 'snapshot-disabled-during-capture')
  }
  const tracker = new ActivityTracker('simple', deps)
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

  try {
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(31_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(captureStarted, true)
    tracker.setOcrConfig({ enabled: false, excludedApps: [] })
    resolveCapture?.()
    await flushAsyncWork()

    deps.setNow(35_000)
    const summary = tracker.finalizeAndConsume()

    assert.equal(summary?.snapshots, undefined)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker drops an OCR snapshot if the app is excluded while capture is pending', async () => {
  const deps = createTrackerDeps()
  let resolveCapture: (() => void) | undefined
  let captureStarted = false
  deps.captureOcrSnapshot = async (sample, trigger) => {
    captureStarted = true
    await new Promise<void>((resolve) => {
      resolveCapture = resolve
    })
    return makeOcrSnapshot(sample, trigger, 'snapshot-excluded-during-capture')
  }
  const tracker = new ActivityTracker('simple', deps)
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

  try {
    tracker.handleWindowBlur()
    deps.intervals[0].callback()
    await flushAsyncWork()

    deps.setNow(31_000)
    deps.timeouts[0].callback()
    await flushAsyncWork()

    assert.equal(captureStarted, true)
    tracker.setOcrConfig({ enabled: true, excludedApps: ['Example Editor'] })
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
  deps.sampleActivity = async () => ({
    appName: 'Example Password Manager',
    bundleId: 'com.example.password-manager'
  })
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

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

test('ActivityTracker does not OCR while input is idle', async () => {
  const deps = createTrackerDeps()
  let captureCalls = 0
  deps.captureOcrSnapshot = async () => {
    captureCalls += 1
    return null
  }
  const tracker = new ActivityTracker('simple', deps)
  tracker.setOcrConfig({ enabled: true, excludedApps: [] })

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

test('ActivityTracker closes input idle time at the last activity timestamp after the user returns', async () => {
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

    assert.equal(summary?.entries[0].inputIdleDurationMs, 15 * 60_000)
    assert.match(summary?.text ?? '', /"inputIdleDuration":"15min"/)
  } finally {
    tracker.finalizeAndConsume()
  }
})

test('ActivityTracker samples episode changes during input idle', async () => {
  const deps = createTrackerDeps()
  deps.setNow(0)
  let title = 'Episode 1'
  deps.sampleActivity = async () => ({
    appName: 'Browser',
    bundleId: 'browser',
    windowTitle: title
  })
  const tracker = new ActivityTracker('full', deps)
  tracker.handleWindowBlur()
  await flushAsyncWork()
  deps.intervals[0].callback()
  await flushAsyncWork()
  deps.setNow(10 * 60_000)
  deps.setIdleTimeMs(10 * 60_000)
  title = 'Episode 2'
  deps.intervals[0].callback()
  await flushAsyncWork()
  deps.setNow(20 * 60_000)
  deps.setIdleTimeMs(20 * 60_000)
  const summary = tracker.finalizeAndConsume()!
  assert.deepEqual(
    summary.entries.map((e) => [e.windowTitle, e.durationMs, e.inputIdleDurationMs]),
    [
      ['Episode 1', 600_000, 600_000],
      ['Episode 2', 600_000, 600_000]
    ]
  )
  assert.equal(summary.afkDurationMs, undefined)
})

test('ActivityTracker excludes overlapping lock and sleep gaps and resumes sampling', async () => {
  const deps = createTrackerDeps()
  deps.setNow(0)
  const tracker = new ActivityTracker('simple', deps)
  tracker.handleWindowBlur()
  deps.intervals[0].callback()
  await flushAsyncWork()
  deps.setNow(600_000)
  deps.setIdleTimeMs(600_000)
  tracker.setSystemPaused('lock', true)
  tracker.setSystemPaused('sleep', true)
  deps.setNow(1_200_000)
  tracker.setSystemPaused('sleep', false)
  assert.equal(deps.intervals.filter((i) => i.active).length, 0)
  deps.setNow(1_800_000)
  tracker.setSystemPaused('lock', false)
  deps.intervals.at(-1)!.callback()
  await flushAsyncWork()
  deps.setNow(2_400_000)
  deps.setIdleTimeMs(2_400_000)
  const summary = tracker.finalizeAndConsume()!
  assert.equal(summary.entries[0].durationMs, 1_200_000)
  assert.equal(summary.entries[0].inputIdleDurationMs, 1_200_000)
})

test('ActivityTracker discards a sample that crosses a lock/unlock boundary', async () => {
  const deps = createTrackerDeps()
  deps.setNow(0)
  let resolveSample!: (value: { appName: string; bundleId: string }) => void
  deps.sampleActivity = () =>
    new Promise((resolve) => {
      resolveSample = resolve
    })
  const tracker = new ActivityTracker('simple', deps)
  tracker.handleWindowBlur()
  deps.intervals[0].callback()
  tracker.setSystemPaused('lock', true)
  deps.setNow(600_000)
  tracker.setSystemPaused('lock', false)
  resolveSample({ appName: 'Stale', bundleId: 'stale' })
  await flushAsyncWork()
  deps.setNow(660_000)
  assert.equal(tracker.finalizeAndConsume(), null)
})

test('ActivityTracker does not count focused or paused gaps as input idle', async () => {
  const deps = createTrackerDeps()
  deps.setNow(0)
  const tracker = new ActivityTracker('simple', deps)
  tracker.handleWindowBlur()
  deps.intervals[0].callback()
  await flushAsyncWork()
  deps.setNow(600_000)
  deps.setIdleTimeMs(600_000)
  tracker.handleWindowFocus()
  deps.setNow(1_800_000)
  tracker.handleWindowBlur()
  deps.intervals.at(-1)!.callback()
  await flushAsyncWork()
  deps.setNow(2_400_000)
  deps.setIdleTimeMs(2_400_000)
  tracker.setSystemPaused('sleep', true)
  deps.setNow(3_600_000)
  const summary = tracker.finalizeAndConsume()!
  assert.equal(summary.entries[0].durationMs, 1_200_000)
  assert.equal(summary.entries[0].inputIdleDurationMs, 1_200_000)
})
