import { networkInterfaces } from 'node:os'

import {
  DEFAULT_REMOTE_CONFIG,
  YACHIYO_CONNECT_SERVER,
  type RemoteConfig
} from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'
import { REMOTE_WS_PATH } from '@yachiyo/shared/remote/wire'

import type { RemoteKeepAwake } from './keepAwake.ts'
import type { RelayCredential } from './relayActivation.ts'

export interface ManagedRemoteService {
  readonly port: number | null
  start(): Promise<void>
  stop(): Promise<void>
  publishEndpoints(): Promise<void>
}

/** The tunnel supervisor as the controller sees it. */
export interface TunnelMonitor {
  monitor(config: RemoteConfig, onChange: (endpoint: RemoteEndpoint | null) => void): void
  stopMonitoring(): void
  endpoint(config: RemoteConfig): RemoteEndpoint | null
}

export interface RemoteServiceParams {
  listen: { host: string; port: number }
  endpoints: () => RemoteEndpoint[]
  relayCredential?: RelayCredential | null
}

export interface RemoteControllerDeps<TService extends ManagedRemoteService> {
  createService(params: RemoteServiceParams): TService
  relayCredential?(server: string): Promise<RelayCredential | null>
  keepAwake: RemoteKeepAwake
  tunnel: TunnelMonitor
  /** First non-internal IPv4 address; injectable for tests. */
  lanAddress?: () => string | null
  log(line: string): void
}

export function firstLanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

function externalEndpoint(value: string): RemoteEndpoint | null {
  try {
    const url = new URL(value)
    if (
      !['https:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== REMOTE_WS_PATH)
    ) {
      return null
    }
    url.protocol = 'wss:'
    url.pathname = REMOTE_WS_PATH
    return { kind: 'tunnel', url: url.href }
  } catch {
    return null
  }
}

/**
 * Reconciles the remote service with the `remote` settings. With `enabled = false` nothing is
 * constructed: no listener, no event subscription, no power blocker. Changes are applied one
 * at a time so a quick toggle cannot leave two servers bound to the port.
 */
export class RemoteController<TService extends ManagedRemoteService> {
  private readonly deps: RemoteControllerDeps<TService>
  private current: { service: TService; key: string; config: RemoteConfig } | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(deps: RemoteControllerDeps<TService>) {
    this.deps = deps
  }

  get service(): TService | null {
    return this.current?.service ?? null
  }

  get config(): RemoteConfig | null {
    return this.current?.config ?? null
  }

  apply(config: RemoteConfig): Promise<void> {
    this.queue = this.queue
      .then(() => this.reconcile(config))
      .catch((error: unknown) => {
        this.deps.log(`[remote] failed to apply settings: ${String(error)}`)
      })
    return this.queue
  }

  stop(): Promise<void> {
    return this.apply({ ...DEFAULT_REMOTE_CONFIG, enabled: false })
  }

  endpoints(config: RemoteConfig, port: number | null): RemoteEndpoint[] {
    const endpoints: RemoteEndpoint[] = []
    const tunnel =
      config.tunnel === 'relay'
        ? null
        : config.tunnel === 'none'
          ? externalEndpoint(config.publicEndpoint)
          : this.deps.tunnel.endpoint(config)
    if (tunnel) endpoints.push(tunnel)
    if (config.lanEndpoint && port !== null) {
      const address = (this.deps.lanAddress ?? firstLanAddress)()
      if (address) endpoints.push({ kind: 'lan', url: `ws://${address}:${port}${REMOTE_WS_PATH}` })
    }
    return endpoints
  }

  private async reconcile(config: RemoteConfig): Promise<void> {
    const key = `${config.port}|${config.lanEndpoint}|${config.tunnel === 'relay'}`
    if (!config.enabled) {
      this.deps.keepAwake.setWanted(false)
      this.deps.tunnel.stopMonitoring()
      if (this.current) {
        await this.current.service.stop()
        this.deps.log('[remote] service stopped')
      }
      this.current = null
      return
    }

    if (this.current && this.current.key !== key) {
      await this.current.service.stop()
      this.current = null
    }
    if (!this.current) {
      let relayCredential: RelayCredential | null = null
      if (config.tunnel === 'relay') {
        relayCredential = (await this.deps.relayCredential?.(YACHIYO_CONNECT_SERVER)) ?? null
      }
      if (config.tunnel === 'relay' && !relayCredential)
        throw new Error('Activate Yachiyo Connect with an invitation before enabling Remote.')
      const service = this.deps.createService({
        listen: { host: config.lanEndpoint ? '0.0.0.0' : '127.0.0.1', port: config.port },
        endpoints: () => this.endpoints(this.current?.config ?? config, service.port),
        relayCredential
      })
      await service.start()
      this.current = { service, key, config }
      this.deps.log(`[remote] service listening on port ${service.port}`)
    } else {
      const oldEndpoints = this.endpoints(this.current.config, this.current.service.port)
      this.current.config = config
      if (
        JSON.stringify(oldEndpoints) !==
        JSON.stringify(this.endpoints(config, this.current.service.port))
      ) {
        await this.current.service.publishEndpoints()
      }
    }
    this.deps.keepAwake.setWanted(config.keepAwakeOnPower)
    // A new quick-tunnel hostname reaches phones through the mailbox.
    if (config.tunnel === 'relay') this.deps.tunnel.stopMonitoring()
    else this.deps.tunnel.monitor(config, () => void this.current?.service.publishEndpoints())
  }
}
