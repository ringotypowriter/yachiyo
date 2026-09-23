import { z } from 'zod'

import { REMOTE_PROTOCOL_VERSION } from './protocolVersion.ts'
import {
  hexIdSchema,
  idSchema,
  isoDateTimeSchema,
  key32Schema,
  remoteEndpointListSchema
} from './common.ts'

export const REMOTE_PAIRING_URL_PREFIX = 'yachiyo-remote://pair'

/** Content of the pairing QR code, carried base64url-encoded in the `d` query parameter. */
export const pairingPayloadSchema = z
  .object({
    v: z.literal(REMOTE_PROTOCOL_VERSION),
    remoteDeviceId: hexIdSchema,
    deviceName: z.string().min(1).max(200),
    desktopKey: key32Schema,
    token: key32Schema,
    endpoints: remoteEndpointListSchema,
    expiresAt: isoDateTimeSchema
  })
  .meta({ id: 'RemotePairingPayload' })

export type PairingPayload = z.infer<typeof pairingPayloadSchema>

/** Plaintext the phone sends inside the first handshake message. */
export const handshakeClientPayloadSchema = z
  .object({
    deviceName: z.string().min(1).max(200),
    app: z.string().min(1).max(100),
    version: z.string().min(1).max(50),
    compression: z.array(z.string().min(1).max(32)).max(8).optional()
  })
  .meta({ id: 'RemoteHandshakeClientPayload' })

export type HandshakeClientPayload = z.infer<typeof handshakeClientPayloadSchema>

/** First transport message after an IKpsk2 pairing handshake; only sent once per pairing. */
export const pairingGrantSchema = z
  .object({
    type: z.literal('pairing.granted'),
    pairingId: idSchema,
    mailboxSecret: key32Schema
  })
  .meta({ id: 'RemotePairingGrant' })

export type PairingGrant = z.infer<typeof pairingGrantSchema>

export function encodePairingUrl(payload: PairingPayload): string {
  const parsed = pairingPayloadSchema.parse(payload)
  const data = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')
  return `${REMOTE_PAIRING_URL_PREFIX}?v=${REMOTE_PROTOCOL_VERSION}&d=${data}`
}

export function decodePairingUrl(url: string): PairingPayload {
  if (!url.startsWith(`${REMOTE_PAIRING_URL_PREFIX}?`)) {
    throw new Error('Not a Yachiyo pairing URL.')
  }
  const params = new URLSearchParams(url.slice(REMOTE_PAIRING_URL_PREFIX.length + 1))
  if (params.get('v') !== String(REMOTE_PROTOCOL_VERSION)) {
    throw new Error('Unsupported pairing URL version.')
  }
  const data = params.get('d')
  if (!data) throw new Error('Pairing URL is missing its payload.')
  const json: unknown = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
  return pairingPayloadSchema.parse(json)
}
