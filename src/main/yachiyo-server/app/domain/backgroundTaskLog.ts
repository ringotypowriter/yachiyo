import { open } from 'node:fs/promises'

import {
  BACKGROUND_TASK_LOG_DEFAULT_MAX_BYTES,
  BACKGROUND_TASK_LOG_HARD_MAX_BYTES
} from '../../../../shared/yachiyo/protocol.ts'

export interface BackgroundTaskLogTail {
  content: string
  truncated: boolean
  totalBytes: number
  startByte: number
}

export function normalizeBackgroundTaskLogMaxBytes(maxBytes?: number): number {
  if (maxBytes === undefined) return BACKGROUND_TASK_LOG_DEFAULT_MAX_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Background task log maxBytes must be a positive integer.')
  }
  return Math.min(maxBytes, BACKGROUND_TASK_LOG_HARD_MAX_BYTES)
}

export async function readBackgroundTaskLogTail(
  logPath: string,
  maxBytes?: number
): Promise<BackgroundTaskLogTail> {
  const byteLimit = normalizeBackgroundTaskLogMaxBytes(maxBytes)
  const file = await open(logPath, 'r')
  try {
    const stats = await file.stat()
    const totalBytes = stats.size
    const startByte = Math.max(0, totalBytes - byteLimit)
    const byteLength = totalBytes - startByte
    const buffer = Buffer.alloc(byteLength)
    if (byteLength > 0) {
      await file.read(buffer, 0, byteLength, startByte)
    }
    return {
      content: buffer.toString('utf8'),
      truncated: startByte > 0,
      totalBytes,
      startByte
    }
  } finally {
    await file.close()
  }
}
