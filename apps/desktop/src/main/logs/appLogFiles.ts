import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseAppLogText, type ReadAppLogsResult } from '@yachiyo/shared/appLogs'

export interface ReadAppLogsInput {
  logsDir: string
  /** Byte offset into main.log from a previous read; enables cheap incremental polling. */
  afterByte?: number
  /** Maximum entries returned on a full read (tail-most kept). */
  limit?: number
}

const DEFAULT_LIMIT = 2000
const NEWLINE = 0x0a

async function readFileOrEmpty(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch {
    return Buffer.alloc(0)
  }
}

/** End offset of the last complete line, so a torn in-flight write is never parsed. */
function completeLineEnd(buffer: Buffer): number {
  const lastNewline = buffer.lastIndexOf(NEWLINE)
  return lastNewline === -1 ? 0 : lastNewline + 1
}

export async function readAppLogEntries(input: ReadAppLogsInput): Promise<ReadAppLogsResult> {
  const current = await readFileOrEmpty(join(input.logsDir, 'main.log'))
  const cursor = completeLineEnd(current)

  const isIncremental = input.afterByte !== undefined
  const rotated = input.afterByte !== undefined && input.afterByte > current.length
  if (isIncremental && !rotated) {
    const appended = current.subarray(input.afterByte, cursor).toString('utf8')
    return { entries: parseAppLogText(appended), cursor, reset: false }
  }

  const archived = await readFileOrEmpty(join(input.logsDir, 'main.old.log'))
  const entries = [
    ...parseAppLogText(archived.toString('utf8')),
    ...parseAppLogText(current.subarray(0, cursor).toString('utf8'))
  ]
  const limit = input.limit ?? DEFAULT_LIMIT
  return { entries: entries.slice(-limit), cursor, reset: rotated }
}
