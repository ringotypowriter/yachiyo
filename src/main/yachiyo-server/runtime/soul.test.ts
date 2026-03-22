import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { readSoulDocument, upsertDailySoulTrait } from './soul.ts'

test('readSoulDocument creates a template when SOUL.md is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-missing-'))
  const filePath = join(root, 'SOUL.md')

  try {
    const soul = await readSoulDocument({
      filePath
    })
    const content = await readFile(filePath, 'utf8')

    await access(filePath)
    assert.deepEqual(soul, {
      filePath,
      evolvedTraits: [],
      lastUpdated: ''
    })
    assert.equal(content, '# SOUL\n\n## Evolved Traits\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readSoulDocument parses evolved traits from the dedicated section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-read-'))
  const filePath = join(root, 'SOUL.md')

  try {
    await writeFile(
      filePath,
      [
        '---',
        'last_updated: 2026-03-22T08:00:00.000Z',
        '---',
        '',
        '# SOUL',
        '',
        '## Evolved Traits',
        '### 2026-03-21',
        '- Speaks more directly when the task is urgent',
        '- Keeps a calm tone around ambiguous requests',
        '',
        '## Notes',
        'Ignore this section'
      ].join('\n')
    )

    const soul = await readSoulDocument({ filePath })

    assert.deepEqual(soul, {
      filePath,
      evolvedTraits: [
        'Speaks more directly when the task is urgent',
        'Keeps a calm tone around ambiguous requests'
      ],
      lastUpdated: '2026-03-22T08:00:00.000Z'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upsertDailySoulTrait merges writes into one entry per day and updates frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-upsert-'))
  const filePath = join(root, 'SOUL.md')

  try {
    await upsertDailySoulTrait({
      filePath,
      now: new Date('2026-03-22T10:00:00.000Z'),
      trait: 'Responds with sharper prioritization'
    })
    await upsertDailySoulTrait({
      filePath,
      now: new Date('2026-03-22T16:30:00.000Z'),
      trait: 'Responds with sharper prioritization'
    })
    await upsertDailySoulTrait({
      filePath,
      now: new Date('2026-03-22T18:45:00.000Z'),
      trait: 'Explains tradeoffs without losing warmth'
    })

    const soul = await readSoulDocument({ filePath })
    const content = await readFile(filePath, 'utf8')

    assert.deepEqual(soul, {
      filePath,
      evolvedTraits: [
        'Responds with sharper prioritization',
        'Explains tradeoffs without losing warmth'
      ],
      lastUpdated: '2026-03-22T18:45:00.000Z'
    })
    assert.match(content, /^---\nlast_updated: 2026-03-22T18:45:00.000Z\n---/m)
    assert.match(
      content,
      /## Evolved Traits\n### 2026-03-22\n- Responds with sharper prioritization\n- Explains tradeoffs without losing warmth/
    )
    assert.equal((content.match(/^### 2026-03-22$/gm) ?? []).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
