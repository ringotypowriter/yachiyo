import assert from 'node:assert/strict'
import test from 'node:test'

import { describeUpdateOutcome } from './updateReceiptMessage.ts'

const base = {
  attemptId: 'attempt-1',
  channelId: 'chan-1',
  threadId: 'thread-1',
  messageId: 'msg-1',
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  startedAtMs: 1_760_000_000_000
}

test('reaching the target version reports success with the version', () => {
  const outcome = describeUpdateOutcome(base, '1.1.0')
  assert.equal(outcome.kind, 'updated')
  assert.match(outcome.message, /1\.1\.0/)
})

/**
 * The branch the whole layer exists for. If this is missing, the user waits
 * forever on a reply that never comes — worse than never having promised one.
 */
test('an unchanged version reports the update did not complete', () => {
  const outcome = describeUpdateOutcome(base, '1.0.0')
  assert.equal(outcome.kind, 'not-completed')
  assert.match(outcome.message, /1\.0\.0/)
  assert.doesNotMatch(
    outcome.message,
    /1\.1\.0.*已更新|已更新到 1\.1\.0/,
    'must not claim the target was installed'
  )
})

/**
 * The renderer can download a different build between prepare and install
 * (issue #48/#49 territory), so the running version after restart is not
 * guaranteed to be either the old one or the intended one. Reporting that as
 * "did not complete" would be confidently wrong.
 */
test('landing on a third version reports what actually happened', () => {
  const outcome = describeUpdateOutcome(base, '1.2.0')
  assert.equal(outcome.kind, 'unexpected-version')
  assert.match(outcome.message, /1\.2\.0/, 'states the version actually running')
  assert.match(outcome.message, /1\.1\.0/, 'and the one that was expected')
})

/**
 * An expired record means we genuinely do not know. Saying so once beats both
 * silence and a guess.
 */
test('an expired record reports an unknown outcome rather than guessing', () => {
  const outcome = describeUpdateOutcome({ ...base, expired: true }, '1.1.0')
  assert.equal(outcome.kind, 'unknown')
  assert.match(outcome.message, /未知|不确定/)
})

test('an expired record reports unknown even when the version did not move', () => {
  const outcome = describeUpdateOutcome({ ...base, expired: true }, '1.0.0')
  assert.equal(outcome.kind, 'unknown')
})

/** Every branch must produce something sendable — no empty receipts. */
test('every outcome carries a non-empty message', () => {
  for (const running of ['1.1.0', '1.0.0', '1.2.0']) {
    assert.ok(describeUpdateOutcome(base, running).message.trim().length > 0, running)
  }
  assert.ok(describeUpdateOutcome({ ...base, expired: true }, '1.1.0').message.trim().length > 0)
})
