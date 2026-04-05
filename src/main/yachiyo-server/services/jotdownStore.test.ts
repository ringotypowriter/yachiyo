import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { createJotdownStore, extractTitle, filenameToISODate } from './jotdownStore.ts'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'yachiyo-jotdown-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('filenameToISODate', () => {
  test('parses filename with milliseconds', () => {
    assert.equal(filenameToISODate('2026-04-05_14-30-00-123'), '2026-04-05T14:30:00.123')
  })

  test('parses legacy filename without milliseconds', () => {
    assert.equal(filenameToISODate('2026-04-05_14-30-00'), '2026-04-05T14:30:00')
  })

  test('handles edge case with no underscore', () => {
    const result = filenameToISODate('invalid')
    // Should return a valid ISO date (falls back to new Date())
    assert.ok(!isNaN(new Date(result).getTime()))
  })
})

describe('extractTitle', () => {
  test('extracts first non-empty line', () => {
    assert.equal(extractTitle('Hello world\nSecond line'), 'Hello world')
  })

  test('strips markdown heading prefix', () => {
    assert.equal(extractTitle('# My Note\nContent'), 'My Note')
    assert.equal(extractTitle('## Sub heading'), 'Sub heading')
  })

  test('skips empty leading lines', () => {
    assert.equal(extractTitle('\n\n  \nActual title'), 'Actual title')
  })

  test('returns (untitled) for empty content', () => {
    assert.equal(extractTitle(''), '(untitled)')
    assert.equal(extractTitle('   \n  \n'), '(untitled)')
  })

  test('truncates at 80 characters', () => {
    const long = 'A'.repeat(100)
    assert.equal(extractTitle(long).length, 80)
  })
})

describe('JotdownStore', () => {
  test('create() generates a file and returns JotdownFull', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      const note = await store.create()

      assert.equal(note.title, '(untitled)')
      assert.equal(note.content, '')
      assert.ok(note.id.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/))

      // File should exist on disk
      const content = await readFile(join(dir, `${note.id}.md`), 'utf8')
      assert.equal(content, '')
    })
  })

  test('create() produces distinct IDs when called rapidly', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      const a = await store.create()
      const b = await store.create()
      assert.notEqual(a.id, b.id)
    })
  })

  test('create() auto-creates directory if missing', async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir, 'sub', 'jotdowns')
      const store = createJotdownStore(nested)
      const note = await store.create()
      assert.ok(note.id)
    })
  })

  test('list() returns empty array for empty directory', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      const notes = await store.list()
      assert.deepEqual(notes, [])
    })
  })

  test('list() returns notes sorted by createdAt descending', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await writeFile(join(dir, '2026-01-01_10-00-00.md'), '# First', 'utf8')
      await writeFile(join(dir, '2026-03-15_08-30-00.md'), '# Third', 'utf8')
      await writeFile(join(dir, '2026-02-10_14-00-00.md'), '# Second', 'utf8')

      const notes = await store.list()
      assert.equal(notes.length, 3)
      assert.equal(notes[0].title, 'Third')
      assert.equal(notes[1].title, 'Second')
      assert.equal(notes[2].title, 'First')
    })
  })

  test('list() ignores non-.md files', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await writeFile(join(dir, '2026-01-01_10-00-00.md'), 'note', 'utf8')
      await writeFile(join(dir, 'readme.txt'), 'not a note', 'utf8')
      await writeFile(join(dir, '.DS_Store'), '', 'utf8')

      const notes = await store.list()
      assert.equal(notes.length, 1)
    })
  })

  test('load() reads note content and metadata', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await writeFile(join(dir, '2026-04-05_14-30-00.md'), '# My Note\nSome content', 'utf8')

      const note = await store.load('2026-04-05_14-30-00')
      assert.equal(note.id, '2026-04-05_14-30-00')
      assert.equal(note.title, 'My Note')
      assert.equal(note.content, '# My Note\nSome content')
      assert.equal(note.createdAt, '2026-04-05T14:30:00')
      assert.ok(note.modifiedAt)
    })
  })

  test('load() throws for non-existent note', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await assert.rejects(() => store.load('does-not-exist'), { code: 'ENOENT' })
    })
  })

  test('save() writes content and returns updated metadata', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await writeFile(join(dir, '2026-04-05_14-30-00.md'), '', 'utf8')

      const meta = await store.save({ id: '2026-04-05_14-30-00', content: '# Updated\nNew body' })
      assert.equal(meta.id, '2026-04-05_14-30-00')
      assert.equal(meta.title, 'Updated')

      // Verify disk content
      const content = await readFile(join(dir, '2026-04-05_14-30-00.md'), 'utf8')
      assert.equal(content, '# Updated\nNew body')
    })
  })

  test('delete() removes the file', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await writeFile(join(dir, '2026-04-05_14-30-00.md'), 'content', 'utf8')

      await store.delete('2026-04-05_14-30-00')

      const notes = await store.list()
      assert.equal(notes.length, 0)
    })
  })

  test('delete() throws for non-existent note', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)
      await assert.rejects(() => store.delete('nope'), { code: 'ENOENT' })
    })
  })

  test('full CRUD lifecycle', async () => {
    await withTempDir(async (dir) => {
      const store = createJotdownStore(dir)

      // Create
      const note = await store.create()
      assert.equal(note.content, '')

      // Save
      const saved = await store.save({ id: note.id, content: '# Hello\nWorld' })
      assert.equal(saved.title, 'Hello')

      // List
      const list = await store.list()
      assert.equal(list.length, 1)
      assert.equal(list[0].id, note.id)
      assert.equal(list[0].title, 'Hello')

      // Load
      const loaded = await store.load(note.id)
      assert.equal(loaded.content, '# Hello\nWorld')

      // Delete
      await store.delete(note.id)
      const afterDelete = await store.list()
      assert.equal(afterDelete.length, 0)
    })
  })
})
