import { Buffer } from 'node:buffer'

import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'
import type { RemoteThreadDetail } from '@yachiyo/shared/remote/projections'

// Leave room for the RPC envelope and transport framing; count bytes, not UTF-16 characters.
export const REMOTE_THREAD_DETAIL_BYTE_BUDGET = REMOTE_MAX_MESSAGE_BYTES - 64 * 1024

export class RemoteValidationError extends Error {
  override name = 'RemoteValidationError'
}

/**
 * Reduce the page, never its content or nonpaged state. Requires no further storage reads.
 * Also returns the UTF-8 JSON size of the result so callers can extend it without
 * serializing the whole detail again.
 */
export function fitRemoteThreadBudgetMeasured(detail: RemoteThreadDetail): {
  detail: RemoteThreadDetail
  byteLength: number
} {
  let page = detail
  for (;;) {
    const byteLength = Buffer.byteLength(JSON.stringify(page), 'utf8')
    if (byteLength <= REMOTE_THREAD_DETAIL_BYTE_BUDGET) return { detail: page, byteLength }
    if (page.messages.length <= 1) {
      throw new RemoteValidationError(
        'This conversation contains a message or active state too large to load remotely. Open it on the desktop.'
      )
    }
    const messages = page.messages.slice(Math.floor(page.messages.length / 2))
    const ids = new Set(messages.map((message) => message.id))
    page = {
      ...page,
      messages,
      hasMoreBefore: true,
      toolCalls: page.toolCalls.filter(
        (tool) =>
          (tool.requestMessageId !== undefined && ids.has(tool.requestMessageId)) ||
          (tool.assistantMessageId !== undefined && ids.has(tool.assistantMessageId)) ||
          (page.activeRunId !== undefined && tool.runId === page.activeRunId)
      )
    }
  }
}

export function fitRemoteThreadBudget(detail: RemoteThreadDetail): RemoteThreadDetail {
  return fitRemoteThreadBudgetMeasured(detail).detail
}
