import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createGroupTurnSendGuard,
  GROUP_TURN_BLOCKED_SEND_MELTDOWN_MESSAGE,
  GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE
} from './groupTurnSendGuard.ts'

describe('createGroupTurnSendGuard', () => {
  it('returns an honest duplicate-drop message on the first blocked attempt', () => {
    const guard = createGroupTurnSendGuard()

    assert.equal(
      guard.recordBlockedAttempt('duplicate'),
      'Dropped: duplicate of a recent outgoing message. Do not retry in this turn.'
    )
  })

  it('melts down after repeated blocked attempts in one turn', () => {
    const guard = createGroupTurnSendGuard()

    assert.equal(
      guard.recordBlockedAttempt('throttled'),
      'Dropped: speech throttle blocked this message. Stay silent for the rest of this turn.'
    )

    assert.throws(() => guard.recordBlockedAttempt('duplicate'), {
      message: GROUP_TURN_BLOCKED_SEND_MELTDOWN_MESSAGE
    })
  })

  it('melts down when the model tries to send again after a successful send', () => {
    const guard = createGroupTurnSendGuard()

    guard.beforeAttempt()
    guard.recordSent()

    assert.throws(() => guard.beforeAttempt(), {
      message: GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE
    })
  })
})
