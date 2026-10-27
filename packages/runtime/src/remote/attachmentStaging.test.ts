import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { REMOTE_ATTACHMENT_CHUNK_BYTES } from '@yachiyo/shared/remote/methods'

import { createAttachmentStaging } from './attachmentStaging.ts'

async function withStaging(
  fn: (staging: ReturnType<typeof createAttachmentStaging>) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-staging-'))
  const staging = createAttachmentStaging({ directory: join(directory, 'uploads') })
  try {
    await fn(staging)
  } finally {
    await staging.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

test('pipelined chunks are applied in arrival order and the commit waits for them', async () => {
  await withStaging(async (staging) => {
    const bytes = randomBytes(REMOTE_ATTACHMENT_CHUNK_BYTES * 3 + 1234)
    const begun = await staging.begin({
      pairingId: 'p',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      size: bytes.length
    })
    assert.equal(begun.maxInFlightChunks, 4)
    const chunks = Array.from({ length: 4 }, (_, index) =>
      bytes.subarray(index * begun.chunkSize, (index + 1) * begun.chunkSize)
    )
    // All chunks and the commit are issued without waiting, like a pipelining phone.
    const received = chunks.map((chunk, index) =>
      staging.chunk({
        pairingId: 'p',
        uploadId: begun.uploadId,
        index,
        data: chunk.toString('base64')
      })
    )
    const committed = staging.commit({
      pairingId: 'p',
      uploadId: begun.uploadId,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    assert.deepEqual(
      (await Promise.all(received)).map((result) => result.received),
      [1, 2, 3, 4].map((count) => Math.min(count * begun.chunkSize, bytes.length))
    )
    assert.equal((await committed).kind, 'file')
    const resolved = await staging.consume('p', [begun.uploadId])
    assert.equal(
      resolved.attachments[0]!.dataUrl,
      `data:text/plain;base64,${bytes.toString('base64')}`
    )
  })
})

test('a pipelined chunk after a failed one is rejected, never written out of order', async () => {
  await withStaging(async (staging) => {
    const begun = await staging.begin({
      pairingId: 'p',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      size: 10
    })
    const results = await Promise.allSettled([
      staging.chunk({ pairingId: 'p', uploadId: begun.uploadId, index: 1, data: 'AAAA' }),
      staging.chunk({ pairingId: 'p', uploadId: begun.uploadId, index: 0, data: 'AAAA' }),
      staging.chunk({ pairingId: 'p', uploadId: begun.uploadId, index: 2, data: 'AAAA' })
    ])
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'fulfilled', 'rejected']
    )
  })
})
