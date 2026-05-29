import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  readSoulDocument,
  upsertDailySoulTrait,
  SOUL_TRAIT_CAP,
  SoulTraitCapError,
  traitHash
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
    assert.equal(rest2.filePath, filePath)
    assert.equal(rest2.evolvedTraits.length, 2)
    assert.equal(rest2.evolvedTraits[0]?.trait, 'Speaks more directly when the task is urgent')
    assert.equal(rest2.evolvedTraits[1]?.trait, 'Keeps a calm tone around ambiguous requests')
    assert.equal(rest2.lastUpdated, '2026-03-22T08:00:00.000Z')
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
    assert.equal(rest3.filePath, filePath)
    assert.equal(rest3.evolvedTraits.length, 2)
    assert.equal(rest3.evolvedTraits[0]?.trait, 'Responds with sharper prioritization')
    assert.equal(rest3.evolvedTraits[1]?.trait, 'Explains tradeoffs without losing warmth')
    assert.equal(rest3.lastUpdated, '2026-03-22T18:45:00.000Z')
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

test('traitHash returns stable 6-char key for same text without collision', () => {
  const key1 = traitHash('hello world', new Set())
  const key2 = traitHash('hello world', new Set())
  assert.equal(key1, key2)
  assert.equal(key1.length, 6)
  assert.ok(/^[0-9a-f]{6}$/.test(key1))

  const key3 = traitHash('different text', new Set())
  assert.notEqual(key3, key1)
})

test('traitHash extends length on real 6-char collision', () => {
  const first = traitHash('collision trait 1904', new Set())
  const second = traitHash('collision trait 3602', new Set([first]))

  assert.equal(first, 'a840a0')
  assert.equal(second, 'a840a00')
  assert.equal(second.length, 7)
})

test('readSoulDocument gives colliding traits unique keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-soul-hash-collision-'))
  const filePath = join(root, 'SOUL.md')

  try {
    await writeFile(
      filePath,
      [
        '# SOUL',
        '',
        '## Evolved Traits',
        '### 2026-05-29',
        '- collision trait 1904',
        '- collision trait 3602'
      ].join('\n')
    )

    const soul = await readSoulDocument({ filePath })
    assert.deepEqual(
      soul?.evolvedTraits.map((t) => t.key),
      ['a840a0', 'a840a00']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
