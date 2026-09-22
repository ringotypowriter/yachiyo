import { z } from 'zod'

import { REASONING_EFFORT_LEVELS, THEME_IDS } from '../protocol.ts'

/** Unpadded RFC 4648 §5 base64url. */
export const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/, 'Expected base64url')

/** Base64url encoding of exactly 32 bytes (X25519 keys, pairing tokens, mailbox secrets). */
export const key32Schema = base64UrlSchema.length(43)

export const hexIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Expected 16-byte lowercase hex')

export const isoDateTimeSchema = z.iso.datetime({ offset: true })

export const idSchema = z.string().min(1).max(200)

export const reasoningSelectionSchema = z
  .enum(['off', ...REASONING_EFFORT_LEVELS])
  .meta({ id: 'RemoteReasoningSelection' })

export const runModeSchema = z
  .enum(['auto', 'explore', 'plan', 'chat'])
  .meta({ id: 'RemoteRunMode' })

export const modelOverrideSchema = z
  .object({
    providerName: z.string().min(1).max(200),
    model: z.string().min(1).max(200)
  })
  .meta({ id: 'RemoteModelOverride' })

export const themeIdSchema = z.enum(THEME_IDS).meta({ id: 'RemoteThemeId' })

export const themeAppearanceSchema = z
  .enum(['system', 'light', 'dark'])
  .meta({ id: 'RemoteThemeAppearance' })

export const activeRunEnterBehaviorSchema = z
  .enum(['enter-steers', 'enter-queues-follow-up'])
  .meta({ id: 'RemoteActiveRunEnterBehavior' })

const wsUrlSchema = z.url({ protocol: /^wss?$/ }).max(2048)

export const remoteEndpointSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('tunnel'), url: wsUrlSchema }),
    z.object({ kind: z.literal('lan'), url: wsUrlSchema })
  ])
  .meta({ id: 'RemoteEndpoint' })

export type RemoteEndpoint = z.infer<typeof remoteEndpointSchema>

export const remoteEndpointListSchema = z.array(remoteEndpointSchema).min(1).max(8)

/** Error names carried in `RpcErrorShape.name` so clients can branch without parsing messages. */
export const REMOTE_ERROR_NAMES = [
  'RemoteProtocolVersionMismatch',
  'RemoteValidationError',
  'RemoteMethodNotFound',
  'RemoteNotFound',
  'RemoteForbidden',
  'RemoteLimitExceeded',
  'RemoteInternalError'
] as const

export type RemoteErrorName = (typeof REMOTE_ERROR_NAMES)[number]
