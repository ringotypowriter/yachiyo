import {
  DEFAULT_REMOTE_CONFIG,
  type RemoteConfig,
  type SettingsConfig
} from '@yachiyo/shared/protocol'
import type { RemoteStatusResult } from '@yachiyo/shared/remote/command'

export function remoteConfigOf(config: SettingsConfig): RemoteConfig {
  return config.remote ?? DEFAULT_REMOTE_CONFIG
}

export function withRemote(config: SettingsConfig, patch: Partial<RemoteConfig>): SettingsConfig {
  return { ...config, remote: { ...remoteConfigOf(config), ...patch } }
}

/** The public host a phone dials, without the scheme and path noise. */
export function remoteAddressLabel(status: RemoteStatusResult | null): string | null {
  const endpoint =
    status?.endpoints.find((entry) => entry.kind === 'tunnel') ?? status?.endpoints[0]
  if (!endpoint) return null
  try {
    return new URL(endpoint.url).host
  } catch {
    return endpoint.url
  }
}

export type RemoteStatusHint = 'cloudflared-stopped' | 'icloud-unavailable' | null

/** At most one hint, most actionable first. */
export function remoteStatusHint(status: RemoteStatusResult | null): RemoteStatusHint {
  if (!status?.running) return null
  if (status.tunnel !== 'none' && !status.cloudflared.agentRunning) return 'cloudflared-stopped'
  if (status.icloudDrive === 'unavailable') return 'icloud-unavailable'
  return null
}
