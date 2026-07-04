import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveYachiyoFileHistoryDir } from '../../config/paths.ts'
import { hashContent, storeBlob, readBlob, deleteBlob } from './casStore.ts'

// Override the data dir for tests
const originalEnv = process.env['YACHIYO_HOME']

test('casStore', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cas-test-'))
  process.env['YACHIYO_HOME'] = tempDir

  t.after(async () => {
    if (originalEnv === undefined) {
      delete process.env['YACHIYO_HOME']
    } else {
      process.env['YACHIYO_HOME'] = originalEnv
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  await t.test('hashContent is deterministic', () => {
    const hash1 = hashContent('hello world')
    const hash2 = hashContent('hello world')
    assert.equal(hash1, hash2)
    assert.equal(hash1.length, 64) // SHA-256 hex
  })

  await t.test('hashContent differs for different content', () => {
    const hash1 = hashContent('hello')
    const hash2 = hashContent('world')
    assert.notEqual(hash1, hash2)
  })

  await t.test('storeBlob + readBlob roundtrip', async () => {
    const content = 'test file content\nwith newlines\n'
    const hash = await storeBlob('workspace1', content)
    assert.equal(hash, hashContent(content))

    const blob = await readBlob('workspace1', hash)
    assert.equal(blob.toString('utf8'), content)
  })

  await t.test('storeBlob deduplicates silently', async () => {
    const content = 'same content'
    const hash1 = await storeBlob('workspace1', content)
    const hash2 = await storeBlob('workspace1', content)
    assert.equal(hash1, hash2)
  })

  await t.test('storeBlob skips the write when the blob already exists', async () => {
    const content = 'existing blob content'
    const hash = await storeBlob('workspace1', content)
    // Tamper with the stored blob out-of-band; a skipped rewrite leaves it untouched.
    const dest = join(resolveYachiyoFileHistoryDir(), 'workspace1', 'backups', hash)
    await writeFile(dest, 'tampered')
    await storeBlob('workspace1', content)
    const blob = await readBlob('workspace1', hash)
    assert.equal(blob.toString('utf8'), 'tampered')
  })

  await t.test('deleteBlob removes the blob', async () => {
    const content = 'to be deleted'
    const hash = await storeBlob('workspace1', content)
    await deleteBlob('workspace1', hash)
    await assert.rejects(() => readBlob('workspace1', hash))
  })

  await t.test('deleteBlob ignores missing blobs', async () => {
    await assert.doesNotReject(() => deleteBlob('workspace1', 'nonexistent'))
  })
})
