import type { ChannelGroupStatus } from '@yachiyo/shared/protocol'

export function parseChannelGroupStatus(raw: string): ChannelGroupStatus {
  switch (raw.trim().toLowerCase()) {
    case 'approved':
    case 'approval':
    case 'approve':
      return 'approved'
    case 'pending':
      return 'pending'
    case 'blocked':
    case 'block':
      return 'blocked'
    default:
      throw new Error(
        `Invalid group monitor status: ${raw}. Expected one of: approved, approval, pending, blocked, block`
      )
  }
}

export function parseLimitFlag(flags: Map<string, string>, fallback: number): number {
  const raw = flags.get('--limit')
  const limit = raw !== undefined ? parseInt(raw, 10) : fallback
  if (isNaN(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got: ${raw}`)
  }
  return limit
}
