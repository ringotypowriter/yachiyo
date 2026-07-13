import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppLogEntry } from '@yachiyo/shared/appLogs'

import { filterAppLogEntries, mergeAppLogReads } from './logsPaneModel.ts'

function entry(overrides: Partial<AppLogEntry>): AppLogEntry {
  return { timestamp: '2026-07-12 10:00:00.000', level: 'info', message: 'msg', ...overrides }
}

test('filterAppLogEntries keeps everything for the all filter', () => {
  const entries = [entry({ level: 'error' }), entry({ level: 'debug' }), entry({ level: 'silly' })]
  assert.deepEqual(filterAppLogEntries(entries, { level: 'all', query: '' }), entries)
})

test('filterAppLogEntries treats level as a minimum severity', () => {
  const entries = [
    entry({ level: 'error', message: 'e' }),
    entry({ level: 'warn', message: 'w' }),
    entry({ level: 'info', message: 'i' }),
    entry({ level: 'debug', message: 'd' })
  ]
  assert.deepEqual(
    filterAppLogEntries(entries, { level: 'warn', query: '' }).map((e) => e.message),
    ['e', 'w']
  )
  assert.deepEqual(
    filterAppLogEntries(entries, { level: 'error', query: '' }).map((e) => e.message),
    ['e']
  )
  assert.deepEqual(
    filterAppLogEntries(entries, { level: 'info', query: '' }).map((e) => e.message),
    ['e', 'w', 'i']
  )
})

test('filterAppLogEntries matches the query case-insensitively on message and timestamp', () => {
  const entries = [
    entry({ message: 'Runtime crashed' }),
    entry({ message: 'all good' }),
    entry({ timestamp: '2026-07-12 11:22:33.000', message: 'other' })
  ]
  assert.deepEqual(
    filterAppLogEntries(entries, { level: 'all', query: 'runtime' }).map((e) => e.message),
    ['Runtime crashed']
  )
  assert.deepEqual(
    filterAppLogEntries(entries, { level: 'all', query: '11:22' }).map((e) => e.message),
    ['other']
  )
})

test('mergeAppLogReads replaces entries on reset and appends otherwise', () => {
  const existing = [entry({ message: 'old' })]
  const appended = mergeAppLogReads(existing, {
    entries: [entry({ message: 'new' })],
    cursor: 10,
    reset: false
  })
  assert.deepEqual(
    appended.map((e) => e.message),
    ['old', 'new']
  )

  const replaced = mergeAppLogReads(existing, {
    entries: [entry({ message: 'fresh' })],
    cursor: 5,
    reset: true
  })
  assert.deepEqual(
    replaced.map((e) => e.message),
    ['fresh']
  )
})

test('mergeAppLogReads caps retained entries at the max, dropping the oldest', () => {
  const existing = Array.from({ length: 4 }, (_, i) => entry({ message: `m${i}` }))
  const merged = mergeAppLogReads(
    existing,
    { entries: [entry({ message: 'm4' })], cursor: 1, reset: false },
    3
  )
  assert.deepEqual(
    merged.map((e) => e.message),
    ['m2', 'm3', 'm4']
  )
})

test('mergeAppLogReads returns the same array when nothing was appended', () => {
  const existing = [entry({ message: 'stable' })]
  assert.equal(mergeAppLogReads(existing, { entries: [], cursor: 3, reset: false }), existing)
})
