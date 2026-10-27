import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { YACHIYO_CONNECT_SERVER } from '@yachiyo/shared/protocol'

import type { SecretBox } from './pairingStore.ts'

export interface RelayCredential {
  server: string
  hostId: string
  key: string
}

const signedTokenSchema = z
  .string()
  .max(224)
  .regex(/^[A-Za-z0-9_-]{60,180}\.[A-Za-z0-9_-]{43}$/)
const tokenPayloadSchema = z.strictObject({
  v: z.literal(1),
  t: z.enum(['invite', 'host']),
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
const credentialSchema = z.object({
  server: z.string(),
  hostId: tokenPayloadSchema.shape.id,
  key: signedTokenSchema
})
type TokenPayload = z.infer<typeof tokenPayloadSchema>

/** Decode public metadata only; the relay verifies the signature, never the desktop. */
function tokenPayload(value: unknown, purpose: TokenPayload['t']): TokenPayload | null {
  const token = signedTokenSchema.safeParse(value)
  if (!token.success) return null
  const encoded = token.data.split('.')[0]!
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) return null
    const parsed = tokenPayloadSchema.safeParse(JSON.parse(bytes.toString('utf8')))
    return parsed.success && parsed.data.t === purpose ? parsed.data : null
  } catch {
    return null
  }
}

/** Invitations are never stored; only the SecretBox-wrapped host credential survives restart. */
export class RelayActivation {
  private readonly path: string
  private readonly directory: string
  private readonly secretBox: SecretBox
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(
    directory: string,
    secretBox: SecretBox,
    fetchImpl: typeof fetch = fetch,
    now = Date.now
  ) {
    this.directory = directory
    this.secretBox = secretBox
    this.fetchImpl = fetchImpl
    this.now = now
    this.path = join(directory, 'relay-activation.bin')
  }

  async load(): Promise<RelayCredential | null> {
    const bytes = await readFile(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!bytes) return null
    const parsed = credentialSchema.safeParse(
      JSON.parse(this.secretBox.decrypt(bytes).toString('utf8'))
    )
    if (!parsed.success || parsed.data.server !== YACHIYO_CONNECT_SERVER) return null
    const payload = tokenPayload(parsed.data.key, 'host')
    if (!payload || payload.id !== parsed.data.hostId || payload.exp <= this.now()) return null
    return parsed.data
  }

  async redeem(code: string): Promise<{ hostId: string }> {
    const origin = YACHIYO_CONNECT_SERVER
    const invitation = tokenPayload(code, 'invite')
    if (!invitation || invitation.exp <= this.now())
      throw new Error('Enter a valid invitation code.')
    const response = await this.fetchImpl(`${origin}/v1/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error('Relay invitation could not be redeemed.')
    const parsed = credentialSchema.omit({ server: true }).safeParse(await response.json())
    const host = parsed.success ? tokenPayload(parsed.data.key, 'host') : null
    if (
      !parsed.success ||
      !host ||
      host.id !== parsed.data.hostId ||
      host.id !== invitation.id ||
      host.exp !== invitation.exp ||
      host.exp <= this.now()
    ) {
      throw new Error('Relay activation response is invalid.')
    }
    const credential: RelayCredential = {
      server: origin,
      hostId: parsed.data.hostId,
      key: parsed.data.key
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, this.secretBox.encrypt(Buffer.from(JSON.stringify(credential))), {
      mode: 0o600
    })
    await rename(temp, this.path)
    return { hostId: credential.hostId }
  }
}
