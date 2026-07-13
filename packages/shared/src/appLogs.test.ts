import assert from 'node:assert/strict'
import test from 'node:test'

import { createLineSplitter, formatAppLogTimestamp, parseAppLogText } from './appLogs.ts'

// ---------------------------------------------------------------------------
// parseAppLogText
// ---------------------------------------------------------------------------

test('parseAppLogText parses a single electron-log line', () => {
  const entries = parseAppLogText('[2026-07-12 10:00:00.123] [info] hello world\n')
  assert.deepEqual(entries, [
    { timestamp: '2026-07-12 10:00:00.123', level: 'info', message: 'hello world' }
  ])
})

test('parseAppLogText parses consecutive lines with distinct levels', () => {
  const text = [
    '[2026-07-12 10:00:00.123] [info] starting up',
    '[2026-07-12 10:00:01.000] [warn] disk almost full',
    '[2026-07-12 10:00:02.500] [error] boom'
  ].join('\n')
  const entries = parseAppLogText(text)
  assert.equal(entries.length, 3)
  assert.deepEqual(
    entries.map((entry) => entry.level),
    ['info', 'warn', 'error']
  )
  assert.equal(entries[2].message, 'boom')
})

test('parseAppLogText folds continuation lines into the previous entry', () => {
  const text = [
    '[2026-07-12 10:00:00.123] [error] Uncaught exception:',
    'Error: kaboom',
    '    at main.ts:12:3',
    '[2026-07-12 10:00:01.000] [info] recovered'
  ].join('\n')
  const entries = parseAppLogText(text)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].message, 'Uncaught exception:\nError: kaboom\n    at main.ts:12:3')
  assert.equal(entries[1].message, 'recovered')
})

test('parseAppLogText keeps leading continuation lines as a headerless entry', () => {
  // A rotated/truncated file can start mid-entry.
  const text = ['    at main.ts:12:3', '[2026-07-12 10:00:01.000] [info] next'].join('\n')
  const entries = parseAppLogText(text)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { timestamp: '', level: 'info', message: '    at main.ts:12:3' })
  assert.equal(entries[1].message, 'next')
})

test('parseAppLogText normalizes unknown levels to info', () => {
  const entries = parseAppLogText('[2026-07-12 10:00:00.123] [whatever] odd line')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].level, 'info')
})

test('parseAppLogText handles CRLF endings and trailing newlines', () => {
  const entries = parseAppLogText('[2026-07-12 10:00:00.123] [info] windows line\r\n\r\n')
  assert.deepEqual(entries, [
    { timestamp: '2026-07-12 10:00:00.123', level: 'info', message: 'windows line' }
  ])
})

test('parseAppLogText returns an empty list for empty input', () => {
  assert.deepEqual(parseAppLogText(''), [])
  assert.deepEqual(parseAppLogText('\n\n'), [])
})

// ---------------------------------------------------------------------------
// formatAppLogTimestamp
// ---------------------------------------------------------------------------

test('formatAppLogTimestamp matches the electron-log file format with zero padding', () => {
  const date = new Date(2026, 6, 12, 9, 5, 3, 45)
  assert.equal(formatAppLogTimestamp(date), '2026-07-12 09:05:03.045')
})

// ---------------------------------------------------------------------------
// createLineSplitter
// ---------------------------------------------------------------------------

test('createLineSplitter reassembles lines split across chunks', () => {
  const lines: string[] = []
  const splitter = createLineSplitter((line) => lines.push(line))
  splitter.push('[runtime] par')
  splitter.push('tial line\n[runtime] second')
  splitter.push(' half\n')
  assert.deepEqual(lines, ['[runtime] partial line', '[runtime] second half'])
})

test('createLineSplitter flush emits the buffered remainder', () => {
  const lines: string[] = []
  const splitter = createLineSplitter((line) => lines.push(line))
  splitter.push('no trailing newline')
  assert.deepEqual(lines, [])
  splitter.flush()
  assert.deepEqual(lines, ['no trailing newline'])
  // Flushing again must not re-emit.
  splitter.flush()
  assert.deepEqual(lines, ['no trailing newline'])
})

test('createLineSplitter strips CR and skips blank lines', () => {
  const lines: string[] = []
  const splitter = createLineSplitter((line) => lines.push(line))
  splitter.push('one\r\n\n   \ntwo\n')
  assert.deepEqual(lines, ['one', 'two'])
})
