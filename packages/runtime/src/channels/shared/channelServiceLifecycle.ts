export interface ManagedChannelService {
  start(): void | Promise<void>
  stop(): void | Promise<void>
  healthCheck(): Promise<boolean>
}

export type ChannelServicePlatform = 'telegram' | 'qq' | 'discord' | 'qqbot'

export interface ChannelServiceLifecycleEntry<TService extends ManagedChannelService> {
  label: string
  enabled(): boolean
  create(): TService
  onServiceChange?: (service: TService | null) => void
}

type ChannelServiceLifecycleEntries = Partial<{
  [K in ChannelServicePlatform]: ChannelServiceLifecycleEntry<ManagedChannelService>
}>

export interface ChannelServiceSupervisor {
  reconcile(platform: ChannelServicePlatform, reason: string): Promise<void>
  reconcileAll(reason: string): Promise<void>
  ensureHealthy(platform: ChannelServicePlatform, reason: string): Promise<void>
  restart(platform: ChannelServicePlatform, reason: string): Promise<void>
  restartAll(reason: string): Promise<void>
  poke(reason: string): Promise<void>
  stop(platform: ChannelServicePlatform, reason: string): Promise<void>
  stopAll(reason: string): Promise<void>
  getService(platform: ChannelServicePlatform): ManagedChannelService | null
}

interface ChannelServiceState {
  service: ManagedChannelService | null
  operationInFlight: Promise<void> | null
  operationKind: ChannelLifecycleOperationKind | null
}

type ChannelLifecycleOperationKind = 'reconcile' | 'ensure' | 'restart' | 'stop'

export function createChannelServiceSupervisor(
  entries: ChannelServiceLifecycleEntries
): ChannelServiceSupervisor {
  const states = new Map<ChannelServicePlatform, ChannelServiceState>()

  function getEntry(
    platform: ChannelServicePlatform
  ): ChannelServiceLifecycleEntry<ManagedChannelService> {
    const entry = entries[platform]
    if (!entry) {
      throw new Error(`[channel-lifecycle] unknown platform: ${platform}`)
    }
    return entry
  }

  function getState(platform: ChannelServicePlatform): ChannelServiceState {
    let state = states.get(platform)
    if (!state) {
      state = { service: null, operationInFlight: null, operationKind: null }
      states.set(platform, state)
    }
    return state
  }

  function setService(
    platform: ChannelServicePlatform,
    service: ManagedChannelService | null
  ): void {
    const state = getState(platform)
    state.service = service
    getEntry(platform).onServiceChange?.(service)
  }

  async function start(platform: ChannelServicePlatform, reason: string): Promise<void> {
    const entry = getEntry(platform)
    const service = entry.create()
    setService(platform, service)
    console.log(`[${entry.label}] starting service (${reason})`)
    try {
      await service.start()
    } catch (error) {
      setService(platform, null)
      try {
        await service.stop()
      } catch (stopError) {
        console.error(`[${entry.label}] stop after failed start failed:`, stopError)
      }
      throw error
    }
  }

  async function stop(platform: ChannelServicePlatform, reason: string): Promise<void> {
    const entry = getEntry(platform)
    const service = getState(platform).service
    if (!service) return
    setService(platform, null)
    console.log(`[${entry.label}] stopping service (${reason})`)
    await service.stop()
  }

  async function runExclusive(
    platform: ChannelServicePlatform,
    kind: ChannelLifecycleOperationKind,
    operation: () => Promise<void>
  ): Promise<void> {
    const state = getState(platform)
    if (state.operationInFlight) {
      if (isDeduplicatedOperation(state.operationKind, kind)) {
        return state.operationInFlight
      }

      const previous = state.operationInFlight
      const nextOperation = previous.catch(() => {}).then(operation)
      const trackedOperation = nextOperation.finally(() => {
        if (state.operationInFlight === trackedOperation) {
          state.operationInFlight = null
          state.operationKind = null
        }
      })
      state.operationInFlight = trackedOperation
      state.operationKind = kind
      return state.operationInFlight
    }

    state.operationInFlight = operation().finally(() => {
      state.operationInFlight = null
      state.operationKind = null
    })
    state.operationKind = kind
    return state.operationInFlight
  }

  function isDeduplicatedOperation(
    currentKind: ChannelLifecycleOperationKind | null,
    nextKind: ChannelLifecycleOperationKind
  ): boolean {
    return (
      (currentKind === 'ensure' || currentKind === 'restart') &&
      (nextKind === 'ensure' || nextKind === 'restart')
    )
  }

  async function reconcile(platform: ChannelServicePlatform, reason: string): Promise<void> {
    return runExclusive(platform, 'reconcile', async () => {
      const entry = getEntry(platform)
      if (!entry.enabled()) {
        await stop(platform, reason)
        console.log(`[${entry.label}] service not started (${reason})`)
        return
      }

      if (!getState(platform).service) {
        await start(platform, reason)
      }
    })
  }

  async function restart(platform: ChannelServicePlatform, reason: string): Promise<void> {
    return runExclusive(platform, 'restart', async () => {
      const entry = getEntry(platform)
      if (!entry.enabled()) {
        await stop(platform, reason)
        console.log(`[${entry.label}] service not restarted; disabled (${reason})`)
        return
      }
      await stop(platform, reason)
      await start(platform, reason)
    })
  }

  async function ensureHealthy(platform: ChannelServicePlatform, reason: string): Promise<void> {
    return runExclusive(platform, 'ensure', async () => {
      const entry = getEntry(platform)
      if (!entry.enabled()) {
        await stop(platform, reason)
        return
      }

      const service = getState(platform).service
      if (!service) {
        await start(platform, reason)
        return
      }

      let healthy = false
      try {
        healthy = await service.healthCheck()
      } catch (error) {
        console.warn(`[${entry.label}] health check failed (${reason}):`, error)
      }

      if (!healthy) {
        console.warn(`[${entry.label}] unhealthy; restarting (${reason})`)
        await stop(platform, reason)
        await start(platform, reason)
      }
    })
  }

  async function forEachPlatform(
    operation: (platform: ChannelServicePlatform) => Promise<void>
  ): Promise<void> {
    await Promise.all(
      (Object.keys(entries) as ChannelServicePlatform[]).map((platform) => operation(platform))
    )
  }

  async function stopExclusive(platform: ChannelServicePlatform, reason: string): Promise<void> {
    await runExclusive(platform, 'stop', () => stop(platform, reason))
  }

  return {
    reconcile,
    async reconcileAll(reason: string): Promise<void> {
      await forEachPlatform((platform) => reconcile(platform, reason))
    },
    ensureHealthy,
    restart,
    async restartAll(reason: string): Promise<void> {
      await forEachPlatform((platform) => restart(platform, reason))
    },
    async poke(reason: string): Promise<void> {
      await forEachPlatform(async (platform) => {
        if (getEntry(platform).enabled()) {
          await ensureHealthy(platform, reason)
        }
      })
    },
    stop: stopExclusive,
    async stopAll(reason: string): Promise<void> {
      await forEachPlatform((platform) => stopExclusive(platform, reason))
    },
    getService(platform: ChannelServicePlatform): ManagedChannelService | null {
      return getState(platform).service
    }
  }
}
