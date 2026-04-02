import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { resolveYachiyoSoulPath, resolveYachiyoUserPath } from '../config/paths.ts'
import { patchUserDocumentSection, readUserDocument, writeUserDocument } from './user.ts'

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

test('patchUserDocumentSection replaces only the target section body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-patch-section-'))
  const filePath = join(root, 'USER.md')

  try {
    await writeUserDocument({
      filePath,
      content: '# Group\n\n## People\n\nold people content\n\n## Group Vibe\n\noriginal vibe\n'
    })

    await patchUserDocumentSection({ filePath, section: 'People', content: 'new people content' })

    const result = await readUserDocument({ filePath })
    assert.ok(result?.content.includes('new people content'), 'new content present')
    assert.ok(!result?.content.includes('old people content'), 'old content removed')
    assert.ok(result?.content.includes('original vibe'), 'other section untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchUserDocumentSection appends a new section when heading is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-patch-append-'))
  const filePath = join(root, 'USER.md')

  try {
    await writeUserDocument({ filePath, content: '# Group\n\n## People\n\nexisting\n' })

    await patchUserDocumentSection({ filePath, section: 'Topic Hints', content: 'hint content' })

    const result = await readUserDocument({ filePath })
    assert.ok(result?.content.includes('## Topic Hints'), 'new heading appended')
    assert.ok(result?.content.includes('hint content'), 'new content present')
    assert.ok(result?.content.includes('existing'), 'existing section untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchUserDocumentSection normalizes section name with whitespace or ## prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-patch-normalize-'))
  const filePath = join(root, 'USER.md')

  try {
    await writeUserDocument({
      filePath,
      content: '# Group\n\n## People\n\noriginal\n\n## Group Vibe\n\nvibe\n'
    })

    // Pass with leading "## " and trailing space — should still match "## People"
    await patchUserDocumentSection({ filePath, section: '## People ', content: 'patched' })

    const result = await readUserDocument({ filePath })
    assert.ok(result?.content.includes('patched'), 'content updated')
    assert.ok(!result?.content.includes('original'), 'old content removed')
    assert.ok(result?.content.includes('vibe'), 'other section untouched')
    // Must not have introduced a duplicate or malformed heading
    const headingCount = (result?.content.match(/^## People/gm) ?? []).length
    assert.equal(headingCount, 1, 'exactly one ## People heading')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchUserDocumentSection creates file from template when missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-patch-missing-'))
  const filePath = join(root, 'USER.md')

  try {
    await patchUserDocumentSection({
      filePath,
      section: 'People',
      content: 'Alice | owner',
      mode: 'group'
    })

    const result = await readUserDocument({ filePath })
    assert.ok(result?.content.includes('Alice | owner'), 'content written')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchUserDocumentSection rebuilds the group template when USER.md lost all headings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-patch-rebuild-'))
  const filePath = join(root, 'USER.md')

  try {
    await writeUserDocument({
      filePath,
      content: '# Group\n\nplain text only\n\nno headings survived\n'
    })

    await patchUserDocumentSection({
      filePath,
      section: 'People',
      content: 'Alice | owner',
      mode: 'group'
    })

    const result = await readUserDocument({ filePath })
    assert.ok(result?.content.includes('## People'), 'group template restored people heading')
    assert.ok(result?.content.includes('## Group Vibe'), 'group template restored vibe heading')
    assert.ok(result?.content.includes('## Topic Hints'), 'group template restored topic heading')
    assert.ok(result?.content.includes('Alice | owner'), 'patched content written')
    assert.ok(!result?.content.includes('plain text only'), 'broken freeform content discarded')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
