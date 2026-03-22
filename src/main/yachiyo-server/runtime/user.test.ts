import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { resolveYachiyoSoulPath, resolveYachiyoUserPath } from '../config/paths.ts'
import { readUserDocument, writeUserDocument } from './user.ts'

test('readUserDocument creates a default template when USER.md is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-user-missing-'))
  const filePath = join(root, 'USER.md')

  try {
    const document = await readUserDocument({ filePath })
    const content = await readFile(filePath, 'utf8')

    await access(filePath)
    assert.deepEqual(document, {
      filePath,
      content
    })
    assert.match(
      content,
      /^# USER\n\nThis file is for Yachiyo's durable understanding of the user\./
    )
    assert.match(
      content,
      /Do not use this file for temporary task state, recalled memory dumps, or chat transcripts\./
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveYachiyoUserPath stays aligned with SOUL.md under the same .yachiyo root', () => {
  const root = '/tmp/yachiyo-context-root'

  assert.equal(resolveYachiyoUserPath(root), join(root, 'USER.md'))
  assert.equal(resolveYachiyoSoulPath(root), join(root, 'SOUL.md'))
  assert.equal(
    resolveYachiyoUserPath(root).replace(/USER\.md$/, ''),
    resolveYachiyoSoulPath(root).replace(/SOUL\.md$/, '')
  )
})

test('writeUserDocument persists direct edits and keeps the file readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-user-write-'))
  const filePath = join(root, 'USER.md')

  try {
    const saved = await writeUserDocument({
      filePath,
      content: '# USER\n\n## Preferences\n- Prefers concise status updates'
    })

    assert.deepEqual(saved, {
      filePath,
      content: '# USER\n\n## Preferences\n- Prefers concise status updates\n'
    })
    assert.equal(
      await readFile(filePath, 'utf8'),
      '# USER\n\n## Preferences\n- Prefers concise status updates\n'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
