import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'

import type { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'
import { createInProcessRemotePorts } from '@yachiyo/runtime/remote/inProcessPorts'
import { RemoteService } from '@yachiyo/runtime/remote/remoteService'
import { RelayActivation } from '@yachiyo/runtime/remote/relayActivation'
import type { PairingRecord, SecretBox } from '@yachiyo/runtime/remote/pairingStore'
import type { RemoteStatusResult } from '@yachiyo/shared/remote/command'
import {
  DEFAULT_REMOTE_CONFIG,
  YACHIYO_CONNECT_SERVER,
  type RemoteConfig
} from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'
import { REMOTE_WS_PATH } from '@yachiyo/shared/remote/wire'

function endpoints(config: RemoteConfig, port: number | null): RemoteEndpoint[] {
  const result: RemoteEndpoint[] = []
  if (config.publicEndpoint) {
    const url = new URL(config.publicEndpoint)
    if (
      !['https:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['/', REMOTE_WS_PATH].includes(url.pathname)
    ) {
      throw new Error(
        'remote.publicEndpoint must be an HTTPS or WSS address, optionally ending in /remote/v1'
      )
    }
    url.protocol = 'wss:'
    url.pathname = REMOTE_WS_PATH
    result.push({ kind: 'tunnel', url: url.href })
  }
  if (config.lanEndpoint && port !== null) {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4' && !address.internal) {
          result.push({ kind: 'lan', url: `ws://${address.address}:${port}${REMOTE_WS_PATH}` })
        }
      }
    }
  }
  return result
}

export interface HeadlessRemote {
  status(): Pick<
    RemoteStatusResult,
    'enabled' | 'tunnel' | 'running' | 'port' | 'endpoints' | 'connections'
  > & { relayConnected: boolean }
  pair(): Promise<{ url: string; expiresAt: string }>
  list(): Promise<PairingRecord[]>
  revoke(pairingId: string): Promise<boolean>
  stop(): Promise<void>
}

export async function startHeadlessRemote(input: {
  home: string
  server: YachiyoServer
  secretBox: SecretBox
  version: string
  log: (line: string) => void
}): Promise<HeadlessRemote> {
  const config = (await input.server.getConfig()).remote ?? DEFAULT_REMOTE_CONFIG
  let service: RemoteService | null = null
  if (config.enabled) {
    if (!['none', 'relay'].includes(config.tunnel)) {
      throw new Error(
        'Headless Remote requires remote.tunnel = "none" with an external TLS proxy, or an activated relay.'
      )
    }
    endpoints(config, config.port)
    const directory = join(input.home, 'remote')
    const activation = new RelayActivation(directory, input.secretBox)
    const credential = config.tunnel === 'relay' ? await activation.load() : null
    if (
      config.tunnel === 'relay' &&
      (!credential || credential.server !== YACHIYO_CONNECT_SERVER)
    ) {
      throw new Error(
        'Activate the relay before enabling it, or use remote.tunnel = "none" and an external endpoint.'
      )
    }
    const ports = createInProcessRemotePorts(input.server)
    service = new RemoteService({
      directory,
      uploadsDirectory: join(directory, 'uploads'),
      secretBox: input.secretBox,
      ...ports,
      subscribe: (listener) => input.server.subscribe(listener),
      listen: { host: config.lanEndpoint ? '0.0.0.0' : '127.0.0.1', port: config.port },
      deviceName: hostname,
      appVersion: input.version,
      endpoints: () => endpoints(config, service?.port ?? null),
      mailboxRoot: null,
      relayCredential: credential,
      log: input.log
    })
    try {
      await service.start()
    } catch (error) {
      await service.stop()
      throw error
    }
  }
  const running = (): RemoteService => {
    if (!service)
      throw new Error('Remote is disabled. Enable it in config and restart yachiyo serve.')
    return service
  }
  return {
    status: () => ({
      enabled: config.enabled,
      tunnel: config.tunnel,
      running: service !== null,
      port: service?.port ?? null,
      connections: service?.status()?.connections ?? 0,
      relayConnected: service?.relayConnected ?? false,
      endpoints: endpoints(config, service?.port ?? null)
    }),
    pair: () => running().createPairingUrl(),
    list: () => running().store.list(),
    revoke: (id) => running().revoke(id),
    stop: async () => {
      await service?.stop()
    }
  }
}
