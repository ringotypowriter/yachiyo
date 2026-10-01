import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolInputProgress } from './toolInputProgress.ts'

test('rejects repeated JSON whitespace across argument fragments', () => {
  const progress = new ToolInputProgress(0)
  progress.append('{', 1)
  progress.append(' \n'.repeat(2047), 2)
  assert.throws(() => progress.append(' \n', 3), /Tool input made no meaningful progress/)
})

test('rejects empty fragments that keep arriving without progress for a minute', () => {
  const progress = new ToolInputProgress(0)
  progress.append('', 59_999)
  assert.throws(() => progress.append('', 60_000), /Tool input made no meaningful progress/)
})

test('preserves formatted JSON and whitespace inside split escaped strings', () => {
  const progress = new ToolInputProgress(0)
  progress.append('{\n "command": "echo \\', 1)
  progress.append('"' + ' '.repeat(10_000), 2)
  progress.append('ok"\n}', 3)
  assert.equal(progress.chars, 10_027)
  assert.equal(progress.deltas, 3)
})

test('meaningful input resets the whitespace count and progress deadline', () => {
  const progress = new ToolInputProgress(0)
  progress.append(' '.repeat(4095), 59_000)
  progress.append('{', 59_001)
  progress.append(' '.repeat(4095), 100_000)
  progress.append('}', 100_001)
  assert.equal(progress.deltas, 4)
})
