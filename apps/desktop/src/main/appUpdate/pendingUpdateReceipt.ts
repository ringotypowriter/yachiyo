import { renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'

/**
 * What we owe the user after a self-triggered update restart.
 *
 * When Yachiyo is told to update herself from a chat, the restart kills the
 * very run that received the order — so nothing is left alive to report back.
 * This record is the only thing that survives, and the post-restart receipt is
 * built entirely from it. If it isn't on disk, the user is left waiting for a
 * reply that can never come.
 */
export interface PendingUpdateReceipt {
  channelId: string
  threadId: string
  messageId: string
  fromVersion: string
  targetVersion: string
  startedAtMs: number
}

export interface ReadPendingUpdateReceipt extends PendingUpdateReceipt {
  /**
   * Set when the record has outlived the window in which its outcome is still
   * meaningful. Expired records are still returned: reporting "I don't know
   * how that update ended" once is honest, whereas deleting the record in
   * silence recreates the disappearance this whole mechanism exists to stop.
   */
  expired?: true
}

/** After a day, an unreported update is no longer a story anyone is waiting on. */
const EXPIRY_MS = 24 * 60 * 60 * 1_000

function isCompleteRecord(value: unknown): value is PendingUpdateReceipt {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['channelId'] === 'string' &&
    typeof record['threadId'] === 'string' &&
    typeof record['messageId'] === 'string' &&
    typeof record['fromVersion'] === 'string' &&
    typeof record['targetVersion'] === 'string' &&
    typeof record['startedAtMs'] === 'number'
  )
}

/**
 * Write via a temporary file and rename, because the process this record
 * describes is about to be killed. A half-written file reads back as no
 * pending update at all, which is indistinguishable from "nothing happened" —
 * the one conclusion that would be wrong.
 */
export function writePendingUpdateReceipt(path: string, receipt: PendingUpdateReceipt): void {
  const temporaryPath = `${path}.writing`
  writeFileSync(temporaryPath, JSON.stringify(receipt), 'utf8')
  renameSync(temporaryPath, path)
}

/**
 * Returns `undefined` when there is nothing to report — including when the
 * record is missing, truncated, or malformed. Those are all "we have no
 * trustworthy story", and inventing one from a damaged record would be worse
 * than staying quiet.
 */
export function readPendingUpdateReceipt(
  path: string,
  nowMs: number
): ReadPendingUpdateReceipt | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (!isCompleteRecord(parsed)) return undefined
  return nowMs - parsed.startedAtMs > EXPIRY_MS ? { ...parsed, expired: true } : parsed
}

/** Clearing an absent record is success: the goal state is "nothing pending". */
export function clearPendingUpdateReceipt(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}.writing`, { force: true })
}
