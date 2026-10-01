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

/** Connect endpoints are managed by the app, not shown or copied in settings. */
export function remoteAddressLabel(status: RemoteStatusResult | null): string | null {
  if (status?.tunnel === 'relay') return null
  const endpoint =
    status?.endpoints.find((entry) => entry.kind === 'tunnel') ?? status?.endpoints[0]
  return endpoint?.url ?? null
}

export type RemoteStatusHint =
  | 'cloudflared-stopped'
  | 'icloud-unavailable'
  | 'quick-address-changes'
  | null

/** At most one hint, most actionable first. */
export function remoteStatusHint(
  status: RemoteStatusResult | null,
  platform = 'darwin'
): RemoteStatusHint {
  if (!status?.running) return null
  if (status.tunnel !== 'none' && status.tunnel !== 'relay' && !status.cloudflared.agentRunning)
    return 'cloudflared-stopped'
  if (platform === 'win32' && status.tunnel === 'quick') return 'quick-address-changes'
  if (platform === 'darwin' && status.icloudDrive === 'unavailable') return 'icloud-unavailable'
  return null
}
