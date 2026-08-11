export const GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE =
  'Stopped: one group message was already sent in this turn. Continue without sending another; new group activity can start a later turn.'

export const GROUP_TURN_ATTEMPT_LIMIT_MESSAGE =
  'Stopped: this turn already used its correction attempt. Continue without sending; new group activity can start a later turn.'

export const GROUP_TURN_DELIVERY_FAILED_MESSAGE =
  'Stopped: delivery already failed in this turn and may be ambiguous. Wait for new group activity instead of risking a duplicate.'

export interface GroupTurnSendGuard {
  beforeAttempt(): void
  recordRetryableRejection(): void
  recordDeliveryFailure(): void
  recordSent(): void
}

export function createGroupTurnSendGuard(): GroupTurnSendGuard {
  let attempts = 0
  let hasSent = false
  let deliveryFailed = false

  return {
    beforeAttempt() {
      if (hasSent) {
        throw new Error(GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE)
      }
      if (deliveryFailed) {
        throw new Error(GROUP_TURN_DELIVERY_FAILED_MESSAGE)
      }
      if (attempts >= 2) {
        throw new Error(GROUP_TURN_ATTEMPT_LIMIT_MESSAGE)
      }
      attempts += 1
    },

    recordRetryableRejection() {
      if (hasSent || deliveryFailed || attempts === 0) {
        throw new Error('Cannot reject a group-message attempt in the current guard state')
      }
    },

    recordDeliveryFailure() {
      if (hasSent || attempts === 0) {
        throw new Error('Cannot record a group-message delivery failure in the current guard state')
      }
      deliveryFailed = true
    },

    recordSent() {
      if (hasSent || deliveryFailed || attempts === 0) {
        throw new Error('Cannot record a successful group-message send in the current guard state')
      }
      hasSent = true
    }
  }
}
