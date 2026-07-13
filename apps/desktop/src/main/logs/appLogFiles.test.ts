import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAppLogEntries } from './appLogFiles.ts'

async function withLogsDir(run: (logsDir: string) => Promise<void>): Promise<void> {
  const logsDir = await mkdtemp(join(tmpdir(), 'yachiyo-app-logs-'))
  try {
    await run(logsDir)
  } finally {
    await rm(logsDir, { recursive: true, force: true })
  }
}

test('readAppLogEntries returns an empty result when no log file exists', async () => {
  await withLogsDir(async (logsDir) => {
    const result = await readAppLogEntries({ logsDir })
    assert.deepEqual(result, { entries: [], cursor: 0, reset: false })
  })
})

test('readAppLogEntries merges the rotated archive before the current file', async () => {
  await withLogsDir(async (logsDir) => {
    await writeFile(join(logsDir, 'main.old.log'), '[2026-07-12 09:00:00.000] [info] archived\n')
    await writeFile(join(logsDir, 'main.log'), '[2026-07-12 10:00:00.000] [info] current\n')
    const result = await readAppLogEntries({ logsDir })
    assert.deepEqual(
      result.entries.map((entry) => entry.message),
      ['archived', 'current']
    )
  })
})

test('readAppLogEntries applies the limit to the tail', async () => {
  await withLogsDir(async (logsDir) => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `[2026-07-12 10:00:0${i}.000] [info] line ${i}`
    )
    await writeFile(join(logsDir, 'main.log'), `${lines.join('\n')}\n`)
    const result = await readAppLogEntries({ logsDir, limit: 2 })
    assert.deepEqual(
      result.entries.map((entry) => entry.message),
      ['line 3', 'line 4']
    )
  })
})

test('readAppLogEntries ignores a torn trailing line and resumes it on the next read', async () => {
  await withLogsDir(async (logsDir) => {
    const complete = '[2026-07-12 10:00:00.000] [info] complete\n'
    await writeFile(join(logsDir, 'main.log'), `${complete}[2026-07-12 10:00:01.000] [inf`)
    const first = await readAppLogEntries({ logsDir })
    assert.deepEqual(
      first.entries.map((entry) => entry.message),
      ['complete']
    )
    assert.equal(first.cursor, Buffer.byteLength(complete))

    await writeFile(
      join(logsDir, 'main.log'),
      `${complete}[2026-07-12 10:00:01.000] [info] finished later\n`
    )
    const second = await readAppLogEntries({ logsDir, afterByte: first.cursor })
    assert.equal(second.reset, false)
    assert.deepEqual(
      second.entries.map((entry) => entry.message),
      ['finished later']
    )
  })
})

test('readAppLogEntries incremental read returns only appended entries', async () => {
  await withLogsDir(async (logsDir) => {
    const initial = '[2026-07-12 10:00:00.000] [info] first\n'
    await writeFile(join(logsDir, 'main.log'), initial)
    const first = await readAppLogEntries({ logsDir })

    await writeFile(
      join(logsDir, 'main.log'),
      `${initial}[2026-07-12 10:00:01.000] [warn] second\n`
    )
    const second = await readAppLogEntries({ logsDir, afterByte: first.cursor })
    assert.equal(second.reset, false)
    assert.deepEqual(second.entries, [
      { timestamp: '2026-07-12 10:00:01.000', level: 'warn', message: 'second' }
    ])
    assert.ok(second.cursor > first.cursor)
  })
})

test('readAppLogEntries detects rotation and resets to a full read', async () => {
  await withLogsDir(async (logsDir) => {
    const bigLine = `[2026-07-12 10:00:00.000] [info] ${'x'.repeat(100)}\n`
    await writeFile(join(logsDir, 'main.log'), bigLine.repeat(3))
    const first = await readAppLogEntries({ logsDir })

    // Rotation: current file restarts small, previous content moves aside.
    await writeFile(join(logsDir, 'main.old.log'), bigLine.repeat(3))
    await writeFile(join(logsDir, 'main.log'), '[2026-07-12 11:00:00.000] [info] fresh\n')
    const second = await readAppLogEntries({ logsDir, afterByte: first.cursor })
    assert.equal(second.reset, true)
    assert.equal(second.entries.length, 4)
    assert.equal(second.entries[3].message, 'fresh')
  })
})
