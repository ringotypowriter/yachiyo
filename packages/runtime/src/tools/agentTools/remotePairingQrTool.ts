import { connect } from 'node:net'
import { isAbsolute } from 'node:path'
import { tool, type Tool } from 'ai'
import { z } from 'zod'

import { resolveYachiyoSocketPath } from '../../config/paths.ts'

export interface PairingQr {
  imagePath: string
  expiresAt: string
}

/** The socket returns a short private local path, never PNG data or the bearer URL. */
export function requestPairingQr(socketPath = resolveYachiyoSocketPath()): Promise<PairingQr> {
  return new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const client = connect(socketPath, () => {
      const message = JSON.stringify({ type: 'remote', action: 'pairing-qr' })
      if (process.platform === 'win32') client.write(`${message}\n`)
      else client.end(message)
    })
    const finish = (error?: Error, result?: PairingQr): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      client.destroy()
      if (error) reject(error)
      else if (result) resolve(result)
    }
    client.setEncoding('utf8')
    client.setTimeout(15_000)
    client.on('data', (chunk: string) => {
      response += chunk
      if (response.length > 200_000) finish(new Error('Pairing image exceeds size limit.'))
    })
    client.on('end', () => {
      try {
        const payload = JSON.parse(response) as {
          ok: boolean
          error?: string
          result?: PairingQr
        }
        if (!payload.ok) return finish(new Error(payload.error ?? 'Pairing failed.'))
        const qr = payload.result
        if (
          !qr ||
          !isAbsolute(qr.imagePath) ||
          !qr.imagePath.endsWith('.png') ||
          !Number.isFinite(Date.parse(qr.expiresAt))
        )
          return finish(new Error('Invalid pairing image response.'))
        finish(undefined, qr)
      } catch {
        finish(new Error('Invalid pairing image response.'))
      }
    })
    client.on('timeout', () => finish(new Error('Pairing image request timed out.')))
    client.on('error', () => finish(new Error('Pairing image request failed.')))
  })
}

/** Only inject into local private runs; never expose a pairing grant to channel runs. */
export function createRemotePairingQrTool(
  request: () => Promise<PairingQr> = requestPairingQr
): Tool<Record<string, never>, string> {
  return tool({
    description:
      'Generate a five-minute iPhone pairing QR image for this private local conversation. Put the returned Markdown image directly in your assistant reply, unchanged. Never print or describe the underlying pairing URL. Do not send this image to any other conversation or channel.',
    inputSchema: z.object({}),
    execute: async () => {
      const qr = await request()
      if (!isAbsolute(qr.imagePath) || !qr.imagePath.endsWith('.png')) {
        throw new Error('Invalid pairing image response.')
      }
      const expiresAt = Date.parse(qr.expiresAt)
      if (!Number.isFinite(expiresAt)) throw new Error('Invalid pairing image response.')
      if (expiresAt <= Date.now()) throw new Error('Pairing image expired.')
      // encodeURIComponent leaves parentheses unescaped, which would break Markdown destinations.
      const encodedPath = encodeURIComponent(qr.imagePath).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      )
      const imageUrl = `yachiyo-asset://local/?p=${encodedPath}`
      return `Scan in Yachiyo on iPhone before ${qr.expiresAt}:\n\n![Pair iPhone with this Mac](${imageUrl})`
    }
  })
}
