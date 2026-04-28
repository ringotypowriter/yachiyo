import assert from 'node:assert/strict'
import test from 'node:test'

import { getChainedSleepTimeoutBlockMessage } from './bashTimeoutGuard.ts'

test('getChainedSleepTimeoutBlockMessage blocks chained sleep that reaches the timeout', () => {
  const message = getChainedSleepTimeoutBlockMessage('sleep 90 && echo done', 60)

  assert.match(message ?? '', /sleep 90/i)
  assert.match(message ?? '', /timeout is 60 seconds/i)
  assert.match(message ?? '', /following command/i)
})

test('getChainedSleepTimeoutBlockMessage allows chained sleep shorter than the timeout', () => {
  assert.equal(getChainedSleepTimeoutBlockMessage('sleep 5 && echo done', 60), undefined)
})

test('getChainedSleepTimeoutBlockMessage ignores quoted shell text', () => {
  assert.equal(getChainedSleepTimeoutBlockMessage('echo "sleep 90 && echo done"', 60), undefined)
})

test('getChainedSleepTimeoutBlockMessage ignores heredoc bodies', () => {
  assert.equal(
    getChainedSleepTimeoutBlockMessage("cat <<'EOF'\nsleep 90 && echo done\nEOF", 60),
    undefined
  )
})

test('getChainedSleepTimeoutBlockMessage blocks cumulative chained sleeps', () => {
  const message = getChainedSleepTimeoutBlockMessage('sleep 30 && sleep 31 && echo done', 60)

  assert.match(message ?? '', /sleep 30 \+ sleep 31/i)
  assert.match(message ?? '', /61 seconds/i)
  assert.match(message ?? '', /timeout is 60 seconds/i)
})
