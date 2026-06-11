/**
 * Shared image download utilities for channel integrations.
 *
 * Main entry point:
 *   - `fetchImageAsDataUrl` — fetches an image by URL and returns a MessageImageRecord
 *
 * Returns `null` on any failure (timeout, oversized, network) so the
 * caller can gracefully fall back to text-only.
 *
 * Unsupported formats (GIF, BMP, etc.) are auto-converted to PNG via sharp
 * so that vision models (Gemini, Claude, GPT-4V) can consume them.
 */

import sharp from 'sharp'
import {
  classifyAttachmentFileSelection,
  MAX_ATTACHMENT_FILE_BYTES,
  resolveAcceptedAttachmentMediaType
} from '@yachiyo/shared/attachmentFileTypes'
import type { MessageImageRecord, SendChatAttachment } from '@yachiyo/shared/protocol'

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
export const ATTACHMENT_MAX_BYTES = MAX_ATTACHMENT_FILE_BYTES

/**
 * Formats natively accepted by major vision model APIs.
 * Anything outside this set gets converted to PNG via sharp.
 */
const VISION_SAFE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif'
])

/**
 * Detect image media type from file magic bytes.
 * Returns `null` if the bytes don't match any known image signature.
 */
export function detectMediaTypeFromBytes(buffer: Buffer): string | null {
  if (buffer.length < 4) return null

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
    return 'image/png'

  // GIF: 47 49 46 38 (GIF8)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38)
    return 'image/gif'

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  )
    return 'image/webp'

  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'

  return null
}

function inferMediaType(name?: string, contentType?: string): string {
  if (contentType?.startsWith('image/')) return contentType
  if (name) {
    const ext = name.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml'
    }
    if (ext && map[ext]) return map[ext]
  }
  return 'image/jpeg' // safe default for Telegram photos
}

/**
 * Infer media type with magic byte detection as highest priority.
 * Falls back to content-type header, then filename extension, then default.
 */
function inferMediaTypeWithBytes(buffer: Buffer, name?: string, contentType?: string): string {
  return detectMediaTypeFromBytes(buffer) ?? inferMediaType(name, contentType)
}

function bufferToDataUrl(buffer: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${buffer.toString('base64')}`
}

function resolveSupportedAttachmentMediaType(filename: string, size?: number): string | null {
  const [classification] = classifyAttachmentFileSelection([{ name: filename, size }]).accepted
  return classification?.mediaType ?? null
}

export async function imageBufferToRecord(input: {
  buffer: Buffer
  filename?: string
  mediaType?: string
  attachmentIndex?: number
}): Promise<MessageImageRecord> {
  const detectedType = inferMediaTypeWithBytes(input.buffer, input.filename, input.mediaType)
  const { buffer, mediaType } = await ensureVisionSafe(input.buffer, detectedType)
  return {
    dataUrl: bufferToDataUrl(buffer, mediaType),
    mediaType,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.attachmentIndex !== undefined ? { attachmentIndex: input.attachmentIndex } : {})
  }
}

export function fileBufferToAttachment(input: {
  buffer: Buffer
  filename: string
  attachmentIndex?: number
}): SendChatAttachment {
  const mediaType = resolveAcceptedAttachmentMediaType({ name: input.filename })
  if (!mediaType) {
    throw new Error(`Unsupported attachment file type: ${input.filename}`)
  }
  return {
    filename: input.filename,
    mediaType,
    dataUrl: bufferToDataUrl(input.buffer, mediaType),
    ...(input.attachmentIndex !== undefined ? { attachmentIndex: input.attachmentIndex } : {})
  }
}

/**
 * Ensure the image buffer is in a vision-model-safe format.
 * If the detected media type is unsupported (e.g. GIF, BMP), convert to PNG
 * using the first frame. Returns `null` if conversion fails.
 */
export async function ensureVisionSafe(
  buffer: Buffer,
  mediaType: string
): Promise<{ buffer: Buffer; mediaType: string }> {
  if (VISION_SAFE_TYPES.has(mediaType)) {
    return { buffer, mediaType }
  }

  // Convert unsupported formats (GIF first frame, BMP, etc.) to PNG.
  console.log(`[channelImage] converting ${mediaType} → image/png`)
  const converted = await sharp(buffer, { animated: false, pages: 1 }).png().toBuffer()
  return { buffer: converted, mediaType: 'image/png' }
}

/**
 * Fetch an image from a URL and convert to a MessageImageRecord.
 * Returns `null` on timeout, oversized response, or network error.
 */
export async function fetchImageAsDataUrl(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number; attachmentIndex?: number; filename?: string }
): Promise<MessageImageRecord | null> {
  const timeoutMs = opts?.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS
  const maxBytes = opts?.maxBytes ?? IMAGE_MAX_BYTES

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs)
    })

    if (!response.ok) {
      console.warn(`[channelImage] fetch failed: ${response.status} ${response.statusText}`)
      return null
    }

    // Early rejection via Content-Length
    const contentLength = Number(response.headers.get('content-length'))
    if (contentLength && contentLength > maxBytes) {
      console.warn(
        `[channelImage] skipping oversized image: Content-Length ${contentLength} > ${maxBytes}`
      )
      return null
    }

    const rawBuffer = Buffer.from(await response.arrayBuffer())

    if (rawBuffer.length > maxBytes) {
      console.warn(
        `[channelImage] skipping oversized image: ${rawBuffer.length} bytes > ${maxBytes}`
      )
      return null
    }

    const contentType = response.headers.get('content-type') ?? undefined
    const filename = opts?.filename ?? (url.split('/').pop()?.split('?')[0] || undefined)
    return await imageBufferToRecord({
      buffer: rawBuffer,
      filename,
      mediaType: contentType,
      ...(opts?.attachmentIndex !== undefined ? { attachmentIndex: opts.attachmentIndex } : {})
    })
  } catch (err) {
    console.warn('[channelImage] failed to fetch image:', err)
    return null
  }
}

export async function fetchFileAsDataUrl(
  url: string,
  opts: {
    filename: string
    mediaType?: string
    timeoutMs?: number
    maxBytes?: number
    attachmentIndex?: number
  }
): Promise<SendChatAttachment | null> {
  const timeoutMs = opts.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? ATTACHMENT_MAX_BYTES

  try {
    const supportedMediaType = resolveSupportedAttachmentMediaType(opts.filename)
    if (!supportedMediaType) {
      console.warn(`[channelAttachment] skipping unsupported file type: ${opts.filename}`)
      return null
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      console.warn(`[channelAttachment] fetch failed: ${response.status} ${response.statusText}`)
      return null
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (contentLength) {
      const checkedMediaType = resolveSupportedAttachmentMediaType(opts.filename, contentLength)
      if (!checkedMediaType) {
        console.warn(`[channelAttachment] skipping unsupported or oversized file: ${opts.filename}`)
        return null
      }
    }
    if (contentLength && contentLength > maxBytes) {
      console.warn(
        `[channelAttachment] skipping oversized file: Content-Length ${contentLength} > ${maxBytes}`
      )
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      console.warn(
        `[channelAttachment] skipping oversized file: ${buffer.length} bytes > ${maxBytes}`
      )
      return null
    }

    return fileBufferToAttachment({
      buffer,
      filename: opts.filename,
      ...(opts.attachmentIndex !== undefined ? { attachmentIndex: opts.attachmentIndex } : {})
    })
  } catch (err) {
    console.warn('[channelAttachment] failed to fetch file:', err)
    return null
  }
}
