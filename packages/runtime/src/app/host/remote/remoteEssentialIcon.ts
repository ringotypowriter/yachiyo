import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { MAX_REMOTE_FILE_BYTES, readBoundedRemoteFile } from './remoteWorkspaceFile.ts'

/** Only pass sources from saved Essentials settings, never a caller-supplied URL or path. */
export async function readEssentialIcon(
  source: string
): Promise<{ mediaType: string; data: string }> {
  let bytes: Buffer
  if (isAbsolute(source) || source.startsWith('file:')) {
    const path = source.startsWith('file:') ? fileURLToPath(source) : source
    bytes = await readBoundedRemoteFile(await realpath(path))
  } else {
    const url = new URL(source)
    if (!['data:', 'https:', 'http:'].includes(url.protocol)) {
      throw new Error('Unsupported Essential image source.')
    }
    if (
      url.protocol === 'data:' &&
      source.length > Math.ceil(MAX_REMOTE_FILE_BYTES / 3) * 4 + 256
    ) {
      throw new Error('Essential image is too large.')
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) throw new Error('Essential image could not be loaded.')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_REMOTE_FILE_BYTES) throw new Error('Essential image is too large.')
      chunks.push(Buffer.from(chunk))
    }
    bytes = Buffer.concat(chunks)
  }
  // Normalize to a bounded, UIKit-compatible format, including configured SVG icons.
  const png = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 })
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
  return { mediaType: 'image/png', data: png.toString('base64') }
}
