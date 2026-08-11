import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createGroupTurnSendGuard,
  GROUP_TURN_ATTEMPT_LIMIT_MESSAGE,
  GROUP_TURN_DELIVERY_FAILED_MESSAGE,
  GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE
} from './groupTurnSendGuard.ts'

describe('createGroupTurnSendGuard', () => {
  it('allows one correction after a retryable rejection', () => {
    const guard = createGroupTurnSendGuard()

    guard.beforeAttempt()
    guard.recordRetryableRejection()
    assert.doesNotThrow(() => guard.beforeAttempt())
  })

  it('stops a third attempt so corrective retries cannot loop', () => {
    const guard = createGroupTurnSendGuard()

    guard.beforeAttempt()
    guard.recordRetryableRejection()
    guard.beforeAttempt()
    guard.recordRetryableRejection()

    assert.throws(() => guard.beforeAttempt(), {
      message: GROUP_TURN_ATTEMPT_LIMIT_MESSAGE
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

  it('stops retries after an ambiguous delivery failure', () => {
    const guard = createGroupTurnSendGuard()

    guard.beforeAttempt()
    guard.recordDeliveryFailure()

    assert.throws(() => guard.beforeAttempt(), {
      message: GROUP_TURN_DELIVERY_FAILED_MESSAGE
    })
  })
})
