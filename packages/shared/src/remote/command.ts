import { z } from 'zod'

import type { RemoteEndpoint } from './common.ts'
import type { RemoteTunnelMode } from '../protocol/remoteSettings.ts'

const hostnameSchema = z
  .string()
  .trim()
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'Expected a hostname'
  )

/** Requests the `yachiyo remote` CLI sends over the command socket (`type: 'remote'`). */
// A plain union: `tunnel-install` appears twice (quick and named), which a discriminated union forbids.
export const remoteCommandRequestSchema = z.union([
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('tunnel-install'), mode: z.literal('quick') }),
  z.object({
    action: z.literal('tunnel-install'),
    mode: z.literal('named'),
    tunnelName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Expected a tunnel name'),
    hostname: hostnameSchema
  }),
  z.object({ action: z.literal('tunnel-uninstall') }),
  z.object({ action: z.literal('pairings-list') }),
  z.object({ action: z.literal('pairing-qr') }),
  z.object({ action: z.literal('pairings-revoke'), pairingId: z.string().trim().min(1) })
])

export type RemoteCommandRequest = z.infer<typeof remoteCommandRequestSchema>

export interface RemoteStatusResult {
  enabled: boolean
  tunnel: RemoteTunnelMode
  /** Whether the app's remote WebSocket server is listening. */
  running: boolean
  port: number | null
  endpoints: RemoteEndpoint[]
  cloudflared: {
    path: string | null
    agentInstalled: boolean
    agentRunning: boolean
    hostname: string | null
    /** `~/.cloudflared/config.yaml` exists, which blocks quick tunnels. */
    conflictingUserConfig: boolean
  }
  icloudDrive: 'available' | 'unavailable'
  pairings: number
  connections: number
}

export interface RemotePairingInfo {
  pairingId: string
  deviceName: string
  createdAt: string
  lastSeenAt?: string
}

export type RemoteCommandResponse = { ok: true; result: unknown } | { ok: false; error: string }
