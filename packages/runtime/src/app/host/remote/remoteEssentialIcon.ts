import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { MAX_REMOTE_FILE_BYTES, readBoundedRemoteFile } from './remoteWorkspaceFile.ts'

function decodeDataImage(url: URL): Buffer {
  const source = url.href.slice('data:'.length).split('#', 1)[0]!
  // Percent encoding can use three source characters per decoded byte.
  if (source.length > MAX_REMOTE_FILE_BYTES * 3 + 256) {
    throw new Error('Essential image is too large.')
  }
  const comma = source.indexOf(',')
  if (comma < 0) throw new Error('Invalid Essential data image.')
  const encoded = Buffer.from(source.slice(comma + 1))
  const decoded = Buffer.allocUnsafe(encoded.length)
  let size = 0
  for (let index = 0; index < encoded.length; index++) {
    const hex = encoded[index] === 37 ? encoded.subarray(index + 1, index + 3).toString() : ''
    if (encoded[index] === 37 && /^[\da-f]{2}$/i.test(hex)) {
      decoded[size++] = Number.parseInt(hex, 16)
      index += 2
    } else {
      decoded[size++] = encoded[index]!
    }
  }
  const payload = decoded.subarray(0, size)
  const bytes = /;base64\s*$/i.test(source.slice(0, comma))
    ? Buffer.from(payload.toString(), 'base64')
    : payload
  if (bytes.length > MAX_REMOTE_FILE_BYTES) throw new Error('Essential image is too large.')
  return bytes
}

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
    if (url.protocol === 'data:') {
      // Electron replaces global fetch with net.fetch, which rejects data URLs.
      bytes = decodeDataImage(url)
    } else {
      if (!['https:', 'http:'].includes(url.protocol)) {
        throw new Error('Unsupported Essential image source.')
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
  }
  // Normalize to a bounded, UIKit-compatible format, including configured SVG icons.
  const png = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 })
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
  return { mediaType: 'image/png', data: png.toString('base64') }
}
