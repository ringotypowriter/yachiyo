import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createActivitySourceCipher, type ActivitySourcePayload } from './activitySourceCrypto.ts'

test('activity source cipher round-trips OCR snapshots in the encrypted payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-activity-source-'))
  const keyPath = join(root, 'activity-source.key')
  const cipher = createActivitySourceCipher({ keyPath })
  const payload: ActivitySourcePayload = {
    version: 2,
    summaryText: 'Worked in Browser on Issue tracker',
    entries: [],
    snapshots: [
      {
        id: 'snapshot-1',
        capturedAt: '2026-05-17T04:30:00.000Z',
        appName: 'Browser',
        bundleId: 'com.example.browser',
        windowTitle: 'Issue tracker',
        source: 'screen',
        trigger: 'initial-blur',
        ocr: {
          engine: 'apple-vision',
          revision: 3,
          confidence: 0.88,
          lineCount: 2,
          contentHash: 'sha256:ocr',
          excerpt: 'Sensitive OCR excerpt',
          text: 'Sensitive OCR full text'
        }
      }
    ]
  }

  try {
    const encrypted = await cipher.encrypt(payload)
    assert.ok(!encrypted.ciphertext.includes('Sensitive OCR'))
    assert.deepEqual(await cipher.decrypt(encrypted), payload)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('activity source cipher encrypts sensitive app and window details at rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-activity-source-'))
  const keyPath = join(root, 'activity-source.key')
  const cipher = createActivitySourceCipher({ keyPath })
  const payload: ActivitySourcePayload = {
    version: 1,
    summaryText: 'Worked in Browser on Issue tracker',
    entries: [
      {
        appName: 'Browser',
        bundleId: 'com.example.browser',
        windowTitle: 'Issue tracker',
        durationMs: 1_000
      }
    ]
  }

  try {
    const encrypted = await cipher.encrypt(payload)
    assert.equal(encrypted.algorithm, 'aes-256-gcm')
    assert.equal(encrypted.keyVersion, 1)
    assert.ok(!encrypted.ciphertext.includes('Browser'))
    assert.ok(!encrypted.ciphertext.includes('Issue tracker'))

    const keyFile = await readFile(keyPath, 'utf8')
    assert.equal(Buffer.from(keyFile, 'base64').byteLength, 32)

    const decrypted = await cipher.decrypt(encrypted)
    assert.deepEqual(decrypted, payload)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
