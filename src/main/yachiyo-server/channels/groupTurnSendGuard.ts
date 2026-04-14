export const GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE =
  'Meltdown: you already sent one group message in this turn. Do not send again.'

export const GROUP_TURN_BLOCKED_SEND_MELTDOWN_MESSAGE =
  'Meltdown: repeated blocked group-message sends in this turn. Stop trying to speak and stay silent.'

type BlockedAttemptKind = 'duplicate' | 'throttled'

export interface GroupTurnSendGuard {
  beforeAttempt(): void
  recordBlockedAttempt(kind: BlockedAttemptKind): string
  recordSent(): void
}

export function createGroupTurnSendGuard(): GroupTurnSendGuard {
  let blockedAttempts = 0
  let hasSent = false

  return {
    beforeAttempt() {
      if (hasSent) {
        throw new Error(GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE)
      }
    },

    recordBlockedAttempt(kind) {
      blockedAttempts += 1
      if (blockedAttempts >= 2) {
        throw new Error(GROUP_TURN_BLOCKED_SEND_MELTDOWN_MESSAGE)
      }

      if (kind === 'duplicate') {
        return 'Dropped: duplicate of a recent outgoing message. Do not retry in this turn.'
      }

      return 'Dropped: you have been talking too much recently. Your message was not sent. Stay silent for the rest of this turn.'
    },

    recordSent() {
      if (hasSent) {
        throw new Error(GROUP_TURN_MULTI_SEND_MELTDOWN_MESSAGE)
      }
      hasSent = true
    }
  }
}
