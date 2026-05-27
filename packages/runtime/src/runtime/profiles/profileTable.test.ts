import assert from 'node:assert/strict'
import test from 'node:test'

import {
  enforceRowCap,
  expireStaleRows,
  parseTable,
  renderTable,
  type SectionSchema,
  type TableRow
} from './profileTable.ts'

const PROFILE_SCHEMA: SectionSchema = { columns: ['Key', 'Value'], keyColumn: 'Key' }
const PEOPLE_SCHEMA: SectionSchema = {
  columns: ['Nickname', 'Identity', 'Notes'],
  keyColumn: 'Nickname'
}

// ---------------------------------------------------------------------------
// renderTable — index column
// ---------------------------------------------------------------------------

test('renderTable includes a leading # column with 0-based indices', () => {
  const rows: TableRow[] = [
    { Key: 'Name', Value: 'Alice', Since: '2026-01-01 00:00' },
    { Key: 'Role', Value: 'Engineer', Since: '2026-01-01 00:00' }
  ]
  const output = renderTable(rows, PROFILE_SCHEMA)
  const lines = output.split('\n')

  // Header starts with #
  assert.match(lines[0], /^\| # \|/)
  assert.match(lines[0], /\| Key \| Value \| Since \|/)

  // Data rows have indices
  assert.match(lines[2], /^\| 0 \| Name \| Alice \|/)
  assert.match(lines[3], /^\| 1 \| Role \| Engineer \|/)
})

test('renderTable with empty rows still has # in header', () => {
  const output = renderTable([], PROFILE_SCHEMA)
  const lines = output.split('\n')
  assert.match(lines[0], /^\| # \|/)
  assert.equal(lines.length, 2) // header + separator only
})

// ---------------------------------------------------------------------------
// parseTable — strips # column
// ---------------------------------------------------------------------------

test('parseTable ignores # column and parses data correctly', () => {
  const bodyLines = [
    '| # | Key | Value | Since |',
    '|---|---|---|---|',
    '| 0 | Name | Alice | 2026-01-01 00:00 |',
    '| 1 | Role | Engineer | 2026-01-01 00:00 |'
  ]
  const { rows, legacyLines } = parseTable(bodyLines, PROFILE_SCHEMA)

  assert.equal(rows.length, 2)
  assert.equal(rows[0].Key, 'Name')
  assert.equal(rows[0].Value, 'Alice')
  assert.equal(rows[1].Key, 'Role')
  assert.equal(rows[1].Value, 'Engineer')
  assert.equal(legacyLines.length, 0)

  // # column should NOT be stored in the row data
  assert.equal(rows[0]['#'], undefined)
  assert.equal(rows[1]['#'], undefined)
})

test('parseTable handles tables without # column (legacy format)', () => {
  const bodyLines = [
    '| Key | Value | Since |',
    '|---|---|---|',
    '| Name | Alice | 2026-01-01 00:00 |'
  ]
  const { rows } = parseTable(bodyLines, PROFILE_SCHEMA)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].Key, 'Name')
  assert.equal(rows[0].Value, 'Alice')
})

// ---------------------------------------------------------------------------
// Round-trip: render → parse preserves data, strips index
// ---------------------------------------------------------------------------

test('round-trip: renderTable output can be parsed back without index leaking', () => {
  const original: TableRow[] = [
    { Nickname: 'xm', Identity: 'Zhang', Notes: 'owner', Since: '2026-01-01 00:00' },
    { Nickname: 'lh', Identity: 'Li', Notes: 'mod', Since: '2026-01-02 00:00' }
  ]
  const rendered = renderTable(original, PEOPLE_SCHEMA)
  const bodyLines = rendered.split('\n')
  const { rows } = parseTable(bodyLines, PEOPLE_SCHEMA)

  assert.equal(rows.length, 2)
  assert.equal(rows[0].Nickname, 'xm')
  assert.equal(rows[0].Identity, 'Zhang')
  assert.equal(rows[0]['#'], undefined)
  assert.equal(rows[1].Nickname, 'lh')
  assert.equal(rows[1]['#'], undefined)
})

// ---------------------------------------------------------------------------
// enforceRowCap
// ---------------------------------------------------------------------------

test('enforceRowCap keeps all rows when under the cap', () => {
  const rows: TableRow[] = [
    { Key: 'a', Value: '1', Since: '2026-01-01 00:00' },
    { Key: 'b', Value: '2', Since: '2026-01-02 00:00' }
  ]
  const result = enforceRowCap(rows, 5)
  assert.equal(result.length, 2)
})

test('enforceRowCap evicts oldest rows when over the cap', () => {
  const rows: TableRow[] = [
    { Key: 'old', Value: '1', Since: '2026-01-01 00:00' },
    { Key: 'mid', Value: '2', Since: '2026-01-05 00:00' },
    { Key: 'new', Value: '3', Since: '2026-01-10 00:00' }
  ]
  const result = enforceRowCap(rows, 2)
  assert.equal(result.length, 2)
  assert.equal(result[0].Key, 'new')
  assert.equal(result[1].Key, 'mid')
})

test('enforceRowCap treats missing Since as oldest', () => {
  const rows: TableRow[] = [
    { Key: 'no-date', Value: '1' },
    { Key: 'has-date', Value: '2', Since: '2026-01-10 00:00' }
  ]
  const result = enforceRowCap(rows, 1)
  assert.equal(result.length, 1)
  assert.equal(result[0].Key, 'has-date')
})

// ---------------------------------------------------------------------------
// expireStaleRows
// ---------------------------------------------------------------------------

test('expireStaleRows removes rows older than ttlDays', () => {
  const now = new Date('2026-01-10T12:00:00Z')
  const rows: TableRow[] = [
    { Key: 'stale', Value: '1', Since: '2026-01-01 00:00' },
    { Key: 'fresh', Value: '2', Since: '2026-01-09 00:00' }
  ]
  const result = expireStaleRows(rows, 3, now)
  assert.equal(result.length, 1)
  assert.equal(result[0].Key, 'fresh')
})

test('expireStaleRows keeps rows without Since timestamp', () => {
  const now = new Date('2026-01-10T12:00:00Z')
  const rows: TableRow[] = [
    { Key: 'no-date', Value: '1' },
    { Key: 'stale', Value: '2', Since: '2026-01-01 00:00' }
  ]
  const result = expireStaleRows(rows, 3, now)
  assert.equal(result.length, 1)
  assert.equal(result[0].Key, 'no-date')
})

test('expireStaleRows keeps all rows when none are stale', () => {
  const now = new Date('2026-01-10T12:00:00Z')
  const rows: TableRow[] = [
    { Key: 'a', Value: '1', Since: '2026-01-08 00:00' },
    { Key: 'b', Value: '2', Since: '2026-01-09 00:00' }
  ]
  const result = expireStaleRows(rows, 3, now)
  assert.equal(result.length, 2)
})
