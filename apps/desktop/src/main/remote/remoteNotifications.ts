import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemoteThreadSummary } from '@yachiyo/shared/remote/projections'

import type { PairingStore } from './pairingStore.ts'
import type { RelayCredential } from './relayActivation.ts'
import { relayServerOrigin } from './relayHost.ts'

interface RemoteNotificationsOptions {
  store: PairingStore
  credential: RelayCredential
  remoteDeviceId: string
  enabled(): Promise<boolean>
  getThreadSummary(threadId: string): Promise<RemoteThreadSummary | null>
  fetch?: typeof fetch
  log(line: string): void
}

/** Push carries a title and opaque route, never message text or model output. */
export class RemoteNotifications {
  private readonly options: RemoteNotificationsOptions
  private readonly fetchImpl: typeof fetch
  private readonly origin: string
  private readonly completedRuns = new Set<string>()
  private stopped = false
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  constructor(options: RemoteNotificationsOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? fetch
    this.origin = relayServerOrigin(options.credential.server)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    await Promise.all(this.pending)
  }

  handle(event: YachiyoServerEvent): Promise<void> {
    const task = this.deliver(event)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return task
  }

  private async deliver(event: YachiyoServerEvent): Promise<void> {
    if (this.stopped || event.type !== 'run.completed') return
    const run = `${event.threadId}:${event.runId}`
    if (this.completedRuns.has(run)) return
    this.completedRuns.add(run)
    if (this.completedRuns.size > 256)
      this.completedRuns.delete(this.completedRuns.values().next().value!)
    try {
      if (!(await this.options.enabled())) return
      const summary = await this.options.getThreadSummary(event.threadId)
      // The host projection excludes archived, deleted and guest-only threads.
      if (!summary || this.stopped) return
      const pairings = await this.options.store.list()
      const results = await Promise.allSettled(
        pairings.map(async ({ pairingId }) => {
          const token = await this.options.store.pushToken(pairingId)
          if (!token || this.stopped) return
          const result = await this.fetchImpl(
            `${this.origin}/v1/hosts/${encodeURIComponent(this.options.credential.hostId)}/push`,
            {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]),
              headers: {
                Authorization: `Bearer ${this.options.credential.key}`,
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                type: 'run-completed',
                token,
                title: summary.title.trim().slice(0, 200) || 'Untitled conversation',
                threadId: event.threadId,
                remoteDeviceId: this.options.remoteDeviceId
              })
            }
          )
          if (!result.ok && !this.stopped) {
            const rejection =
              result.status === 400
                ? ((await result.json().catch(() => null)) as { reason?: unknown } | null)
                : null
            const invalidToken =
              result.status === 410 ||
              rejection?.reason === 'BadDeviceToken' ||
              rejection?.reason === 'DeviceTokenNotForTopic'
            // Clear only this registration, never a token rotated while the request was in flight.
            if (invalidToken && !this.stopped)
              await this.options.store.clearPushToken(pairingId, token)
            if (!this.stopped) this.options.log(`[remote] push rejected (${result.status})`)
          }
          if (!result.bodyUsed) await result.body?.cancel()
        })
      )
      if (!this.stopped && results.some((result) => result.status === 'rejected')) {
        this.options.log('[remote] push unavailable')
      }
    } catch {
      if (!this.stopped) this.options.log('[remote] push unavailable')
    }
  }
}
