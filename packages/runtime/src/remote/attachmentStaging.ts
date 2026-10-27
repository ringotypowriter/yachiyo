import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import {
  classifyAttachmentFileSelection,
  isSensitiveAttachmentFilename,
  MAX_ATTACHMENT_FILE_BYTES
} from '@yachiyo/shared/attachmentFileTypes'
import type { MessageImageRecord, SendChatAttachment } from '@yachiyo/shared/protocol'
import {
  REMOTE_ATTACHMENT_CHUNK_BYTES,
  REMOTE_MAX_FILES_PER_MESSAGE,
  REMOTE_MAX_IMAGES_PER_MESSAGE
} from '@yachiyo/shared/remote/methods'

import { RemoteError } from './remoteErrors.ts'

const UNREFERENCED_TTL_MS = 30 * 60 * 1000
/** Chunks a phone may pipeline per upload; they are still applied strictly in index order. */
export const REMOTE_UPLOAD_MAX_IN_FLIGHT_CHUNKS = 4

interface Upload {
  id: string
  pairingId: string
  filename: string
  mediaType: string
  kind: 'image' | 'file'
  size: number
  received: number
  nextIndex: number
  hash: ReturnType<typeof createHash>
  path: string
  handle: FileHandle | null
  committed: boolean
  createdAt: number
  /** Serializes chunk writes and the commit, so pipelined chunks land in arrival order. */
  queue: Promise<void>
}

/** Same split as the desktop composer: any `image/*` is an image, everything else a file. */
function acceptedMediaType(input: { filename: string; mediaType: string; size: number }): string {
  if (isSensitiveAttachmentFilename(input.filename)) {
    throw new RemoteError('RemoteValidationError', 'Attachment rejected: sensitive-file.')
  }
  if (input.mediaType.startsWith('image/')) {
    if (input.size > MAX_ATTACHMENT_FILE_BYTES) {
      throw new RemoteError('RemoteLimitExceeded', 'Attachment rejected: too-large.')
    }
    return input.mediaType
  }
  const classified = classifyAttachmentFileSelection([
    { name: input.filename, type: input.mediaType, size: input.size }
  ])
  const accepted = classified.accepted[0]
  if (!accepted) {
    const reason = classified.rejected[0]?.reason ?? 'unsupported-type'
    throw new RemoteError('RemoteValidationError', `Attachment rejected: ${reason}.`)
  }
  return accepted.mediaType
}

export interface ResolvedAttachments {
  images: MessageImageRecord[]
  attachments: SendChatAttachment[]
}

export interface AttachmentStaging {
  begin(input: {
    pairingId: string
    filename: string
    mediaType: string
    size: number
  }): Promise<{ uploadId: string; chunkSize: number; maxInFlightChunks: number }>
  chunk(input: {
    pairingId: string
    uploadId: string
    index: number
    data: string
  }): Promise<{ received: number }>
  commit(input: {
    pairingId: string
    uploadId: string
    sha256: string
  }): Promise<{ attachmentId: string; kind: 'image' | 'file' }>
  /** Reads committed uploads as data URLs and removes them; each id is usable once. */
  consume(pairingId: string, attachmentIds: readonly string[]): Promise<ResolvedAttachments>
  sweep(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Chunked uploads from the phone, staged on disk so a 25 MB file never sits in memory as
 * base64. Chunks are written as they arrive and hashed incrementally; unreferenced uploads
 * are removed after 30 minutes.
 */
export function createAttachmentStaging(options: {
  directory: string
  now?: () => number
}): AttachmentStaging {
  const now = options.now ?? Date.now
  const uploads = new Map<string, Upload>()

  function requireUpload(pairingId: string, uploadId: string): Upload {
    const upload = uploads.get(uploadId)
    // Uploads are scoped to the pairing that created them.
    if (!upload || upload.pairingId !== pairingId) {
      throw new RemoteError('RemoteNotFound', 'Upload not found.')
    }
    return upload
  }

  /** Runs `step` after every earlier chunk/commit of this upload has settled. */
  function enqueue<T>(upload: Upload, step: () => Promise<T>): Promise<T> {
    const result = upload.queue.then(() => {
      if (uploads.get(upload.id) !== upload) {
        throw new RemoteError('RemoteNotFound', 'Upload not found.')
      }
      return step()
    })
    upload.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async function discard(upload: Upload): Promise<void> {
    uploads.delete(upload.id)
    await upload.handle?.close().catch(() => undefined)
    upload.handle = null
    await rm(upload.path, { force: true })
  }

  return {
    async begin(input) {
      const mediaType = acceptedMediaType(input)
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      const id = randomUUID()
      const path = join(options.directory, id)
      uploads.set(id, {
        id,
        pairingId: input.pairingId,
        filename: input.filename,
        mediaType,
        kind: mediaType.startsWith('image/') ? 'image' : 'file',
        size: input.size,
        received: 0,
        nextIndex: 0,
        hash: createHash('sha256'),
        path,
        handle: await open(path, 'w', 0o600),
        committed: false,
        createdAt: now(),
        queue: Promise.resolve()
      })
      return {
        uploadId: id,
        chunkSize: REMOTE_ATTACHMENT_CHUNK_BYTES,
        maxInFlightChunks: REMOTE_UPLOAD_MAX_IN_FLIGHT_CHUNKS
      }
    },

    async chunk(input) {
      const upload = requireUpload(input.pairingId, input.uploadId)
      return enqueue(upload, async () => {
        if (upload.committed || !upload.handle) {
          throw new RemoteError('RemoteValidationError', 'Upload is already committed.')
        }
        if (input.index !== upload.nextIndex) {
          throw new RemoteError('RemoteValidationError', 'Upload chunk out of order.')
        }
        const bytes = Buffer.from(input.data, 'base64')
        if (
          bytes.length > REMOTE_ATTACHMENT_CHUNK_BYTES ||
          upload.received + bytes.length > upload.size
        ) {
          await discard(upload)
          throw new RemoteError('RemoteLimitExceeded', 'Upload exceeds its declared size.')
        }
        await upload.handle.write(bytes)
        upload.hash.update(bytes)
        upload.received += bytes.length
        upload.nextIndex += 1
        return { received: upload.received }
      })
    },

    async commit(input) {
      const upload = requireUpload(input.pairingId, input.uploadId)
      return enqueue(upload, async () => {
        if (upload.committed) {
          return { attachmentId: upload.id, kind: upload.kind }
        }
        const digest = upload.hash.digest('hex')
        if (upload.received !== upload.size || digest !== input.sha256) {
          await discard(upload)
          throw new RemoteError('RemoteValidationError', 'Upload is incomplete or corrupted.')
        }
        await upload.handle?.close()
        upload.handle = null
        upload.committed = true
        return { attachmentId: upload.id, kind: upload.kind }
      })
    },

    async consume(pairingId, attachmentIds) {
      const selected = attachmentIds.map((id) => {
        const upload = requireUpload(pairingId, id)
        if (!upload.committed) {
          throw new RemoteError('RemoteValidationError', 'Attachment upload is not committed.')
        }
        return upload
      })
      const images = selected.filter((upload) => upload.kind === 'image')
      const files = selected.filter((upload) => upload.kind === 'file')
      if (
        images.length > REMOTE_MAX_IMAGES_PER_MESSAGE ||
        files.length > REMOTE_MAX_FILES_PER_MESSAGE
      ) {
        throw new RemoteError('RemoteLimitExceeded', 'Too many attachments for one message.')
      }

      const resolved: ResolvedAttachments = { images: [], attachments: [] }
      for (const upload of selected) {
        const dataUrl = `data:${upload.mediaType};base64,${(await readFile(upload.path)).toString('base64')}`
        if (upload.kind === 'image') {
          resolved.images.push({ dataUrl, mediaType: upload.mediaType, filename: upload.filename })
        } else {
          resolved.attachments.push({
            dataUrl,
            mediaType: upload.mediaType,
            filename: upload.filename
          })
        }
      }
      for (const upload of selected) await discard(upload)
      return resolved
    },

    async sweep() {
      const cutoff = now() - UNREFERENCED_TTL_MS
      for (const upload of [...uploads.values()]) {
        if (upload.createdAt < cutoff) await discard(upload)
      }
    },

    async dispose() {
      for (const upload of [...uploads.values()]) await discard(upload)
      await rm(options.directory, { recursive: true, force: true })
    }
  }
}
