// Standalone policy: no Electron imports, scheduler, network or launchctl side effects.
export const WATCHDOG_INTERVAL_MS = 30_000
const GRACE_MS = 90_000
const WINDOW_MS = 15 * 60_000

// The adapter must honor the signal: a deadline bounds waiting, not an uncancellable OS action.
export async function runBounded(operation, { signal, timeoutMs }) {
  const controller = new AbortController()
  let timer
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => {
      controller.abort()
      reject(new Error('Watchdog operation cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Watchdog operation timed out'))
    }, timeoutMs)
  })
  try {
    if (signal.aborted) throw new Error('Watchdog operation cancelled')
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('Watchdog operation cancelled')
        return operation(controller.signal)
      }),
      cancelled
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export class TunnelWatchdog {
  constructor({
    observe,
    restart,
    now = Date.now,
    random = Math.random,
    probeTimeoutMs = 15_000,
    restartTimeoutMs = 15_000,
    budget
  }) {
    this.observe = observe
    this.restart = restart
    this.now = now
    this.random = random
    this.probeTimeoutMs = probeTimeoutMs
    this.restartTimeoutMs = restartTimeoutMs
    const startedAt = now()
    this.graceUntil = startedAt + GRACE_MS
    this.cooldownUntil = 0
    this.lastTickAt = null
    this.attempts = []
    if (budget && Number.isFinite(budget.savedAt)) {
      const shift = Math.min(0, startedAt - budget.savedAt)
      if (Array.isArray(budget.attempts)) {
        this.attempts = budget.attempts
          .filter(
            (at) => Number.isFinite(at) && at <= budget.savedAt && budget.savedAt - at < WINDOW_MS
          )
          .map((at) => at + shift)
          .filter((at) => startedAt - at < WINDOW_MS)
          .sort((a, b) => a - b)
          .slice(-3)
      }
      if (
        Number.isFinite(budget.cooldownUntil) &&
        budget.cooldownUntil >= budget.savedAt &&
        budget.cooldownUntil - budget.savedAt <= 300_000
      ) {
        this.cooldownUntil = budget.cooldownUntil + shift
      }
    }
    this.stopped = false
    this.inFlight = null
    this.controller = null
    this.snapshot = {
      reason: 'startup-grace',
      haConnections: null,
      lastCheckedAt: null,
      lastRestartAt: null,
      nextEligibleAt: this.graceUntil,
      attemptCount: 0,
      failedAttemptCount: 0,
      consecutiveZero: 0
    }
  }

  status() {
    const now = this.now()
    this.attempts = this.attempts.filter((at) => now - at < WINDOW_MS)
    return {
      ...this.snapshot,
      attemptCount: this.attempts.length,
      nextEligibleAt: Math.max(
        this.graceUntil,
        this.cooldownUntil,
        this.attempts.length >= 3 ? this.attempts[0] + WINDOW_MS : 0
      )
    }
  }

  checkpoint() {
    const savedAt = this.now()
    if (this.lastTickAt !== null && savedAt < this.lastTickAt) {
      this.enterWakeGrace(savedAt)
      this.lastTickAt = savedAt
    }
    this.status()
    return { attempts: [...this.attempts], cooldownUntil: this.cooldownUntil, savedAt }
  }

  stop() {
    this.stopped = true
    this.controller?.abort()
    this.snapshot.reason = 'stopped'
  }

  enterWakeGrace(now) {
    const gap = now - this.lastTickAt
    if (gap < 0) {
      // Rebase policy deadlines, retaining the budget instead of forgiving attempts.
      this.attempts = this.attempts.map((at) => at + gap)
      this.cooldownUntil += gap
    }
    this.graceUntil = now + GRACE_MS
    this.snapshot.consecutiveZero = 0
    this.snapshot.reason = 'wake-grace'
  }

  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const now = this.now()
    const gap = this.lastTickAt === null ? 0 : now - this.lastTickAt
    if (this.lastTickAt !== null && gap >= 0 && gap < WATCHDOG_INTERVAL_MS) {
      return Promise.resolve()
    }
    if (gap > GRACE_MS || gap < 0) {
      this.enterWakeGrace(now)
    }
    this.lastTickAt = now
    this.controller = new AbortController()
    this.inFlight = this.check(this.controller.signal).finally(() => {
      this.inFlight = null
      this.controller = null
    })
    return this.inFlight
  }

  async check(signal) {
    let observation
    try {
      observation = await runBounded(this.observe, {
        signal,
        timeoutMs: this.probeTimeoutMs
      })
    } catch {
      if (this.stopped) return
      this.snapshot.lastCheckedAt = this.now()
      this.snapshot.haConnections = null
      this.snapshot.consecutiveZero = 0
      this.snapshot.reason = 'probe-unknown'
      return
    }
    if (this.stopped || signal.aborted) return
    const now = this.now()
    // A suspend can also occur while an observation is pending. Discard that sample.
    if (now - this.lastTickAt > GRACE_MS || now < this.lastTickAt) {
      this.enterWakeGrace(now)
      this.lastTickAt = now
      return
    }
    const ha = observation?.haConnections
    this.snapshot.lastCheckedAt = now
    this.snapshot.haConnections = Number.isFinite(ha) && ha >= 0 ? ha : null
    const suppress = (reason) => {
      this.snapshot.reason = reason
      this.snapshot.consecutiveZero = 0
    }
    if (now < this.graceUntil) {
      suppress(this.snapshot.reason === 'wake-grace' ? 'wake-grace' : 'grace')
      return
    }
    if (this.snapshot.haConnections === null) return suppress('metrics-unknown')
    if (ha > 0) return suppress('healthy-ha')
    if (observation.originHealthy !== true) return suppress('origin-unhealthy-or-unknown')
    if (observation.networkHealthy !== true) return suppress('network-unhealthy-or-unknown')
    this.snapshot.consecutiveZero += 1
    if (this.snapshot.consecutiveZero < 3) {
      this.snapshot.reason = 'confirming-zero-ha'
      return
    }
    if (observation.publicStatus !== 530 && observation.publicErrorCode !== 1033) {
      this.snapshot.reason = 'public-not-corroborated'
      return
    }
    const status = this.status()
    if (status.attemptCount >= 3) {
      this.snapshot.reason = 'restart-budget-exhausted'
      return
    }
    if (now < status.nextEligibleAt) {
      this.snapshot.reason = 'restart-cooldown'
      return
    }
    // Count attempts before invoking I/O, including failed or timed-out kickstarts.
    this.attempts.push(now)
    this.snapshot.lastRestartAt = now
    this.snapshot.consecutiveZero = 0
    this.snapshot.reason = 'restarting'
    const jitter = Math.max(0, Math.min(1, this.random())) * 30_000
    this.cooldownUntil =
      now + Math.min(300_000, GRACE_MS * 2 ** (this.attempts.length - 1) + jitter)
    this.graceUntil = now + GRACE_MS
    try {
      await runBounded(this.restart, { signal, timeoutMs: this.restartTimeoutMs })
      if (this.stopped || signal.aborted) return
      this.snapshot.reason = 'restart-grace'
    } catch {
      if (this.stopped || signal.aborted) return
      this.snapshot.failedAttemptCount += 1
      this.snapshot.reason = 'restart-failed'
    }
    this.graceUntil = this.now() + GRACE_MS
  }
}
