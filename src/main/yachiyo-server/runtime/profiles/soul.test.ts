import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  readSoulDocument,
  upsertDailySoulTrait,
  SOUL_TRAIT_CAP,
  SoulTraitCapError
} from './soul.ts'

test('readSoulDocument creates a template when SOUL.md is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-missing-'))
  const filePath = join(root, 'SOUL.md')

  try {
    const soul = await readSoulDocument({
      filePath
    })
    const content = await readFile(filePath, 'utf8')

    await access(filePath)
    const { rawContent: rawContent1, ...rest1 } = soul!
    assert.ok(rawContent1)
    assert.deepEqual(rest1, {
      filePath,
      evolvedTraits: [],
      lastUpdated: ''
    })
    assert.match(content, /^# SOUL/)
    assert.match(content, /## Rules/)
    assert.match(content, /## Evolved Traits/)
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

    const { rawContent: rawContent2, ...rest2 } = soul!
    assert.ok(rawContent2)
    assert.deepEqual(rest2, {
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

test('upsertDailySoulTrait rejects when trait cap is reached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-cap-'))
  const filePath = join(root, 'SOUL.md')

  try {
    const traits = Array.from({ length: SOUL_TRAIT_CAP }, (_, i) => `Trait number ${i + 1}`)
    const traitLines = traits.map((t) => `- ${t}`).join('\n')
    await writeFile(
      filePath,
      [
        '---',
        'last_updated: 2026-04-01T00:00:00.000Z',
        '---',
        '',
        '# SOUL',
        '',
        '## Evolved Traits',
        '### 2026-04-01',
        traitLines
      ].join('\n')
    )

    const doc = await readSoulDocument({ filePath })
    assert.equal(doc?.evolvedTraits.length, SOUL_TRAIT_CAP)

    await assert.rejects(
      () =>
        upsertDailySoulTrait({
          filePath,
          now: new Date('2026-04-02T10:00:00.000Z'),
          trait: 'One trait too many'
        }),
      (err: unknown) => {
        assert.ok(err instanceof SoulTraitCapError)
        assert.equal(err.currentCount, SOUL_TRAIT_CAP)
        assert.equal(err.cap, SOUL_TRAIT_CAP)
        assert.equal(err.existingTraits.length, SOUL_TRAIT_CAP)
        assert.match(err.message, /Soul trait cap reached/)
        assert.match(err.message, /consolidate/)
        return true
      }
    )

    // File should be unchanged
    const docAfter = await readSoulDocument({ filePath })
    assert.equal(docAfter?.evolvedTraits.length, SOUL_TRAIT_CAP)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upsertDailySoulTrait allows re-adding an existing trait at cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-cap-dup-'))
  const filePath = join(root, 'SOUL.md')

  try {
    const traits = Array.from({ length: SOUL_TRAIT_CAP }, (_, i) => `Trait number ${i + 1}`)
    const traitLines = traits.map((t) => `- ${t}`).join('\n')
    await writeFile(
      filePath,
      [
        '---',
        'last_updated: 2026-04-01T00:00:00.000Z',
        '---',
        '',
        '# SOUL',
        '',
        '## Evolved Traits',
        '### 2026-04-01',
        traitLines
      ].join('\n')
    )

    // Re-adding an existing trait on the same day (no-op)
    const doc = await upsertDailySoulTrait({
      filePath,
      now: new Date('2026-04-01T12:00:00.000Z'),
      trait: 'Trait number 5'
    })
    assert.equal(doc?.evolvedTraits.length, SOUL_TRAIT_CAP)

    // Re-adding an existing trait on a different day (cross-day duplicate, still no-op for count)
    const doc2 = await upsertDailySoulTrait({
      filePath,
      now: new Date('2026-04-02T10:00:00.000Z'),
      trait: 'Trait number 5'
    })
    assert.equal(doc2?.evolvedTraits.length, SOUL_TRAIT_CAP)
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

    const { rawContent: rawContent3, ...rest3 } = soul!
    assert.ok(rawContent3)
    assert.deepEqual(rest3, {
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
