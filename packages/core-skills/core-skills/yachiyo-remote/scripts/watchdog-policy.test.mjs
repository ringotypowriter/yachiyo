import assert from 'node:assert/strict'
import test from 'node:test'
import { TunnelWatchdog, runBounded } from './watchdog-policy.mjs'

function fixture(overrides = {}) {
  let now = 0
  let restarts = 0
  let probes = 0
  let observation = {
    haConnections: 0,
    originHealthy: true,
    networkHealthy: true,
    publicStatus: 530
  }
  const watchdog = new TunnelWatchdog({
    now: () => now,
    random: () => 0,
    observe: async () => {
      probes += 1
      return observation
    },
    restart: async () => {
      restarts += 1
    },
    ...overrides
  })
  return {
    watchdog,
    at: async (time) => {
      now = time
      await watchdog.tick()
    },
    set: (patch) => {
      observation = { ...observation, ...patch }
    },
    counts: () => ({ restarts, probes })
  }
}

async function confirm(f) {
  await f.at(0)
  await f.at(30_000)
  await f.at(60_000)
  await f.at(90_000)
  await f.at(120_000)
  await f.at(150_000)
}

test('startup grace then three zero HA samples with corroboration restart once', async () => {
  const f = fixture()
  await f.at(0)
  await f.at(60_000)
  assert.equal(f.watchdog.status().consecutiveZero, 0)
  await f.at(90_000)
  await f.at(120_000)
  assert.equal(f.counts().restarts, 0)
  await f.at(150_000)
  assert.equal(f.counts().restarts, 1)
  assert.deepEqual(f.watchdog.status(), {
    reason: 'restart-grace',
    haConnections: 0,
    lastCheckedAt: 150_000,
    lastRestartAt: 150_000,
    nextEligibleAt: 240_000,
    attemptCount: 1,
    failedAttemptCount: 0,
    consecutiveZero: 0
  })
  await f.at(180_000)
  assert.equal(f.watchdog.status().consecutiveZero, 0)
})

for (const [name, patch, reason] of [
  ['healthy HA despite public failure', { haConnections: 2 }, 'healthy-ha'],
  ['unknown metrics', { haConnections: null }, 'metrics-unknown'],
  ['NaN metrics', { haConnections: NaN }, 'metrics-unknown'],
  ['negative metrics', { haConnections: -1 }, 'metrics-unknown'],
  ['origin down', { originHealthy: false }, 'origin-unhealthy-or-unknown'],
  ['origin unknown', { originHealthy: null }, 'origin-unhealthy-or-unknown'],
  ['global offline', { networkHealthy: false }, 'network-unhealthy-or-unknown'],
  ['network unknown', { networkHealthy: undefined }, 'network-unhealthy-or-unknown'],
  ['uncorroborated public failure', { publicStatus: 502 }, 'public-not-corroborated']
]) {
  test(`${name} suppresses restart`, async () => {
    const f = fixture()
    f.set(patch)
    await confirm(f)
    assert.equal(f.counts().restarts, 0)
    assert.equal(f.watchdog.status().reason, reason)
  })
}

test('1033 corroborates; unknown samples break consecutive zero sequence', async () => {
  const f = fixture()
  f.set({ publicStatus: null, publicErrorCode: 1033 })
  await f.at(0)
  await f.at(90_000)
  f.set({ haConnections: null })
  await f.at(120_000)
  f.set({ haConnections: 0 })
  await f.at(150_000)
  await f.at(180_000)
  assert.equal(f.counts().restarts, 0)
  await f.at(210_000)
  assert.equal(f.counts().restarts, 1)
})

test('wake gap starts fresh 90s grace, rather than using stale zero samples', async () => {
  const f = fixture()
  await f.at(0)
  await f.at(90_000)
  await f.at(120_000)
  await f.at(211_000)
  assert.equal(f.watchdog.status().reason, 'wake-grace')
  assert.equal(f.watchdog.status().nextEligibleAt, 301_000)
  await f.at(241_000)
  await f.at(271_000)
  await f.at(301_000)
  await f.at(331_000)
  assert.equal(f.counts().restarts, 0)
  await f.at(361_000)
  assert.equal(f.counts().restarts, 1)
})

test('singleflight observations, 30s cadence, and stop aborts stale probe before restart', async () => {
  let resolve
  let signal
  let calls = 0
  const f = fixture({
    observe: (s) => {
      calls += 1
      signal = s
      return new Promise((r) => {
        resolve = r
      })
    }
  })
  const first = f.watchdog.tick()
  assert.equal(f.watchdog.tick(), first)
  await Promise.resolve()
  f.watchdog.stop()
  assert.equal(signal.aborted, true)
  resolve({ haConnections: 0, originHealthy: true, networkHealthy: true, publicStatus: 530 })
  await first
  await f.at(150_000)
  assert.equal(calls, 1)
  assert.equal(f.counts().restarts, 0)
  assert.equal(f.watchdog.status().reason, 'stopped')
  const regular = fixture()
  await regular.at(0)
  await regular.at(29_999)
  assert.equal(regular.counts().probes, 1)
  await regular.at(30_000)
  assert.equal(regular.counts().probes, 2)
})

test('failed restart attempts consume budget and bounded backoff; window eventually expires', async () => {
  const f = fixture({
    restart: async () => {
      throw new Error('private details')
    }
  })
  await confirm(f)
  assert.equal(f.watchdog.status().failedAttemptCount, 1)
  for (let time = 180_000; time <= 750_000; time += 30_000) await f.at(time)
  const status = f.watchdog.status()
  assert.equal(status.attemptCount, 3)
  assert.equal(status.failedAttemptCount, 3)
  assert.equal(status.reason, 'restart-budget-exhausted')
  assert.equal(status.nextEligibleAt, 1_050_000)
  assert.equal(JSON.stringify(status).includes('private details'), false)
  for (let time = 780_000; time <= 1_050_000; time += 30_000) await f.at(time)
  assert.equal(f.watchdog.status().failedAttemptCount, 4)
  assert.equal(f.watchdog.status().attemptCount, 3)
})

test('cooldown uses bounded jitter and applies even to successful restarts', async () => {
  const f = fixture({ random: () => 1 })
  await confirm(f)
  assert.equal(f.watchdog.status().nextEligibleAt, 270_000)
  for (let time = 180_000; time <= 300_000; time += 30_000) await f.at(time)
  assert.equal(f.counts().restarts, 2)
  assert.equal(f.watchdog.status().nextEligibleAt, 510_000)
  for (let time = 330_000; time <= 480_000; time += 30_000) await f.at(time)
  assert.equal(f.watchdog.status().reason, 'restart-cooldown')
  assert.equal(f.counts().restarts, 2)
})

test('bounded operation aborts a hung adapter on deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const controller = new AbortController()
  const pending = runBounded(
    (s) => {
      signal = s
      return new Promise(() => {})
    },
    { signal: controller.signal, timeoutMs: 100 }
  )
  await Promise.resolve()
  t.mock.timers.tick(100)
  await assert.rejects(pending, /timed out/)
  assert.equal(signal.aborted, true)
})

test('probe exception is unknown rather than zero and does not leak error content', async () => {
  const f = fixture({
    observe: async () => {
      throw new Error('secret URL')
    }
  })
  await confirm(f)
  assert.equal(f.counts().restarts, 0)
  assert.equal(f.watchdog.status().haConnections, null)
  assert.equal(f.watchdog.status().reason, 'probe-unknown')
  assert.equal(JSON.stringify(f.watchdog.status()).includes('secret'), false)
})

test('stop aborts in-flight restart and late completion cannot alter stopped state', async () => {
  let signal
  let finish
  const f = fixture({
    restart: (s) => {
      signal = s
      return new Promise((resolve) => {
        finish = resolve
      })
    }
  })
  await f.at(0)
  await f.at(90_000)
  await f.at(120_000)
  const pending = f.at(150_000)
  // Drain the bounded observe continuation and allow restart callback to begin.
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(signal.aborted, false)
  f.watchdog.stop()
  assert.equal(signal.aborted, true)
  finish()
  await pending
  assert.equal(f.watchdog.status().reason, 'stopped')
  assert.equal(f.watchdog.status().attemptCount, 1)
})

test('clock rollback resets grace and rebases cooldown without clearing restart budget', async () => {
  const f = fixture()
  await confirm(f)
  await f.at(0)
  assert.equal(f.watchdog.status().reason, 'wake-grace')
  assert.equal(f.watchdog.status().nextEligibleAt, 90_000)
  assert.equal(f.watchdog.status().attemptCount, 1)
  await f.at(30_000)
  await f.at(60_000)
  await f.at(90_000)
  await f.at(120_000)
  await f.at(150_000)
  assert.equal(f.counts().restarts, 2)
})

test('a hung restart times out, counts as failure, and does not overlap later ticks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  let calls = 0
  const f = fixture({
    restart: (s) => {
      signal = s
      calls += 1
      return new Promise(() => {})
    },
    restartTimeoutMs: 100
  })
  await f.at(0)
  await f.at(90_000)
  await f.at(120_000)
  const pending = f.at(150_000)
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  const overlapping = f.watchdog.tick()
  assert.equal(calls, 1)
  t.mock.timers.tick(100)
  await pending
  await overlapping
  assert.equal(signal.aborted, true)
  assert.equal(f.watchdog.status().failedAttemptCount, 1)
  assert.equal(f.watchdog.status().reason, 'restart-failed')
  await f.at(180_000)
  assert.equal(calls, 1)
})

test('checkpoint preserves attempts and cooldown across controller respawn', async () => {
  const first = fixture()
  await confirm(first)
  for (let time = 180_000; time <= 480_000; time += 30_000) await first.at(time)
  const budget = first.watchdog.checkpoint()
  assert.deepEqual(budget, {
    attempts: [150_000, 300_000, 480_000],
    cooldownUntil: 780_000,
    savedAt: 480_000
  })
  let now = 480_000
  let restarts = 0
  const restored = new TunnelWatchdog({
    budget,
    now: () => now,
    random: () => 0,
    observe: async () => ({
      haConnections: 0,
      originHealthy: true,
      networkHealthy: true,
      publicStatus: 530
    }),
    restart: async () => {
      restarts += 1
    }
  })
  assert.deepEqual(restored.checkpoint(), budget)
  budget.attempts.length = 0
  assert.equal(restored.status().attemptCount, 3)
  for (; now <= 1_020_000; now += 30_000) await restored.tick()
  assert.equal(restarts, 0)
  assert.equal(restored.status().reason, 'restart-budget-exhausted')
  await restored.tick()
  assert.equal(restarts, 1)
})

test('restored checkpoints expire normally and rebase safely after clock rollback', () => {
  const budget = { attempts: [150_000, 300_000, 480_000], cooldownUntil: 780_000, savedAt: 480_000 }
  const expired = fixture({ now: () => 1_400_000, budget })
  assert.equal(expired.watchdog.status().attemptCount, 0)
  const rolledBack = fixture({ now: () => 400_000, budget })
  assert.deepEqual(rolledBack.watchdog.checkpoint(), {
    attempts: [70_000, 220_000, 400_000],
    cooldownUntil: 700_000,
    savedAt: 400_000
  })
  assert.equal(rolledBack.watchdog.status().nextEligibleAt, 970_000)
})

test('malformed persisted budget cannot introduce future attempts or unbounded cooldown', () => {
  const invalid = fixture({ budget: { savedAt: '0', attempts: [0], cooldownUntil: Infinity } })
  assert.equal(invalid.watchdog.status().attemptCount, 0)
  const filtered = fixture({
    now: () => 1_000_000,
    budget: {
      savedAt: 1_000_000,
      attempts: [NaN, Infinity, '0', null, 0, 1_000_001, 500_000, 600_000, 700_000, 800_000],
      cooldownUntil: 2_000_000
    }
  })
  assert.deepEqual(filtered.watchdog.checkpoint(), {
    attempts: [600_000, 700_000, 800_000],
    cooldownUntil: 0,
    savedAt: 1_000_000
  })
})
