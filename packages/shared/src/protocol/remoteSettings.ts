/** How the remote service is reached from outside the Mac. */
export type RemoteTunnelMode = 'quick' | 'named' | 'none'

export interface RemoteConfig {
  enabled: boolean
  tunnel: RemoteTunnelMode
  /** Loopback port served by the remote WebSocket server. */
  port: number
  /** cloudflared `--metrics` port, read for the current quick-tunnel hostname. */
  metricsPort: number
  /** Public hostname of a named tunnel; unused for quick tunnels. */
  namedHostname: string
  /** Also listen on the LAN and advertise a `lan` endpoint. */
  lanEndpoint: boolean
  /** Hold a power-save blocker while remote is enabled and on AC power. */
  keepAwakeOnPower: boolean
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  enabled: false,
  tunnel: 'quick',
  port: 47831,
  metricsPort: 47832,
  namedHostname: '',
  lanEndpoint: false,
  keepAwakeOnPower: true
}
