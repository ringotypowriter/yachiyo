import {
  DEFAULT_REMOTE_CONFIG,
  type RemoteConfig,
  type SettingsConfig
} from '@yachiyo/shared/protocol'
import type {
  RemoteCommandRequest,
  RemotePairingInfo,
  RemoteStatusResult
} from '@yachiyo/shared/remote/command'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import type { ICloudDriveState } from './mailboxWriter.ts'
import type { PairingRecord } from './pairingStore.ts'
import type { TunnelInstallMode, TunnelStatus } from './tunnelSupervisor.ts'

export interface RemoteCommandDeps {
  getConfig(): Promise<SettingsConfig>
  /** Persists settings; the resulting `settings.updated` event reapplies the remote service. */
  saveConfig(config: SettingsConfig): Promise<unknown>
  tunnel: {
    install(install: TunnelInstallMode, ports: { port: number; metricsPort: number }): Promise<void>
    uninstall(): Promise<void>
    status(config: RemoteConfig): Promise<TunnelStatus>
    hasConflictingUserConfig(): boolean
  }
  service(): {
    port: number | null
    connections: number
    endpoints: RemoteEndpoint[]
  } | null
  listPairings(): Promise<PairingRecord[]>
  revokePairing(pairingId: string): Promise<boolean>
  icloudDrive(): Promise<ICloudDriveState>
}

function remoteConfigOf(config: SettingsConfig): RemoteConfig {
  return config.remote ?? DEFAULT_REMOTE_CONFIG
}

async function status(deps: RemoteCommandDeps): Promise<RemoteStatusResult> {
  const remote = remoteConfigOf(await deps.getConfig())
  const [tunnel, pairings, icloudDrive] = await Promise.all([
    deps.tunnel.status(remote),
    deps.listPairings(),
    deps.icloudDrive()
  ])
  const service = deps.service()
  return {
    enabled: remote.enabled,
    tunnel: remote.tunnel,
    running: service !== null,
    port: service?.port ?? null,
    endpoints: service?.endpoints ?? [],
    cloudflared: {
      path: tunnel.cloudflaredPath,
      agentInstalled: tunnel.agentInstalled,
      agentRunning: tunnel.agentRunning,
      hostname: tunnel.hostname,
      conflictingUserConfig: deps.tunnel.hasConflictingUserConfig()
    },
    icloudDrive,
    pairings: pairings.length,
    connections: service?.connections ?? 0
  }
}

/** Handles `yachiyo remote …` requests arriving over the command socket. */
export async function handleRemoteCommand(
  request: RemoteCommandRequest,
  deps: RemoteCommandDeps
): Promise<RemoteStatusResult | RemotePairingInfo[] | { revoked: boolean }> {
  switch (request.action) {
    case 'status':
      return status(deps)
    case 'tunnel-install': {
      const config = await deps.getConfig()
      const remote = remoteConfigOf(config)
      const install: TunnelInstallMode =
        request.mode === 'quick'
          ? { mode: 'quick' }
          : { mode: 'named', tunnelName: request.tunnelName, hostname: request.hostname }
      await deps.tunnel.install(install, { port: remote.port, metricsPort: remote.metricsPort })
      await deps.saveConfig({
        ...config,
        remote: {
          ...remote,
          enabled: true,
          tunnel: request.mode,
          namedHostname: request.mode === 'named' ? request.hostname : remote.namedHostname
        }
      })
      return status(deps)
    }
    case 'tunnel-uninstall': {
      await deps.tunnel.uninstall()
      const config = await deps.getConfig()
      await deps.saveConfig({ ...config, remote: { ...remoteConfigOf(config), tunnel: 'none' } })
      return status(deps)
    }
    case 'pairings-list':
      return (await deps.listPairings()).map((pairing) => ({
        pairingId: pairing.pairingId,
        deviceName: pairing.deviceName,
        createdAt: pairing.createdAt,
        ...(pairing.lastSeenAt ? { lastSeenAt: pairing.lastSeenAt } : {})
      }))
    case 'pairings-revoke':
      return { revoked: await deps.revokePairing(request.pairingId) }
  }
}
