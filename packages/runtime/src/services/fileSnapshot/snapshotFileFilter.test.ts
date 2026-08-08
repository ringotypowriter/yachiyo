import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isSnapshotTextContent,
  MAX_SNAPSHOT_FILE_BYTES,
  readSnapshotEligibleFile
} from './snapshotFileFilter.ts'

test('snapshot file filter', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'snapshot-file-filter-test-'))

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  await t.test('accepts empty and UTF-8 text content', () => {
    assert.equal(isSnapshotTextContent(Buffer.alloc(0)), true)
    assert.equal(
      isSnapshotTextContent(Buffer.from("const greeting = '你好'\n\treturn greeting\n")),
      true
    )
  })

  await t.test('rejects binary and invalid UTF-8 content', () => {
    assert.equal(isSnapshotTextContent(Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff])), false)
    assert.equal(isSnapshotTextContent(Buffer.from([0xc3, 0x28])), false)
  })

  await t.test('rejects unsupported ASCII control characters', () => {
    assert.equal(isSnapshotTextContent(Buffer.from('before\u001bafter')), false)
  })

  await t.test('accepts a text file at the size limit', async () => {
    const filePath = join(tempDir, 'at-limit.txt')
    await writeFile(filePath, Buffer.alloc(MAX_SNAPSHOT_FILE_BYTES, 0x61))

    const content = await readSnapshotEligibleFile(filePath)

    assert.equal(content?.length, MAX_SNAPSHOT_FILE_BYTES)
  })

  await t.test('rejects a file above the size limit', async () => {
    const filePath = join(tempDir, 'above-limit.txt')
    await writeFile(filePath, Buffer.alloc(MAX_SNAPSHOT_FILE_BYTES + 1, 0x61))

    assert.equal(await readSnapshotEligibleFile(filePath), null)
  })
})
