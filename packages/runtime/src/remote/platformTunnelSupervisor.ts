import type { RemoteConfig } from '@yachiyo/shared/protocol'

import { defaultTunnelPaths, TunnelSupervisor } from './tunnelSupervisor.ts'
import { WindowsTunnelSupervisor } from './windowsTunnelSupervisor.ts'

export type RemoteTunnelSupervisor = Pick<
  TunnelSupervisor,
  | 'install'
  | 'uninstall'
  | 'status'
  | 'hasConflictingUserConfig'
  | 'monitor'
  | 'stopMonitoring'
  | 'endpoint'
>

const EXTERNAL_TUNNEL_GUIDANCE =
  'Built-in remote tunnels are unavailable on this platform. Run a TLS reverse proxy or cloudflared outside Yachiyo, then choose External endpoint and set its HTTPS or WSS public address.'

export function createPlatformTunnelSupervisor(options: {
  platform: NodeJS.Platform
  yachiyoHome: string
  uid?: number
  log?: (line: string) => void
}): RemoteTunnelSupervisor {
  if (options.platform === 'win32') return new WindowsTunnelSupervisor(options)
  if (options.platform === 'darwin') {
    return new TunnelSupervisor({
      paths: defaultTunnelPaths(options.yachiyoHome),
      uid: options.uid ?? process.getuid?.() ?? 501,
      log: options.log
    })
  }

  // External ingress is owned by the user. Never run launchctl, change its configuration,
  // or advertise a named tunnel merely because settings were copied from another platform.
  return {
    install: async () => {
      throw new Error(EXTERNAL_TUNNEL_GUIDANCE)
    },
    // Allows the CLI to reset a stale managed-tunnel setting without touching external ingress.
    uninstall: async () => undefined,
    status: async () => ({
      cloudflaredPath: null,
      agentInstalled: false,
      agentRunning: false,
      hostname: null,
      endpoint: null
    }),
    hasConflictingUserConfig: () => false,
    endpoint: () => null,
    monitor: (config: RemoteConfig) => {
      if (config.enabled && config.tunnel !== 'none') {
        options.log?.(`[remote] ${EXTERNAL_TUNNEL_GUIDANCE}`)
      }
    },
    stopMonitoring: () => undefined
  }
}
