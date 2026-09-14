import { randomUUID } from 'node:crypto'
import type { RpcClient } from '@yachiyo/shared/rpc/rpcClient'

import {
  BROWSER_AUTOMATION_TOOL_METHODS,
  type BrowserAutomationToolBackend
} from './browserAutomationToolBackend.ts'

const RPC_METHOD_PREFIX = 'browserAutomation.'
const CANCEL_METHOD = `${RPC_METHOD_PREFIX}cancel`

/** Browser-only cancellation: signals stay local; request IDs cross the transport. */
export function createBrowserAutomationRpcTarget(
  backend: BrowserAutomationToolBackend
): Record<string, (input: never) => unknown> {
  const requests = new Map<string, AbortController>()
  return {
    ...Object.fromEntries(
      BROWSER_AUTOMATION_TOOL_METHODS.map((method) => [
        `${RPC_METHOD_PREFIX}${method}`,
        async (input: Record<string, unknown>) => {
          const { browserRequestId, ...payload } = input
          if (typeof browserRequestId !== 'string') return backend[method](input as never)
          const controller = new AbortController()
          requests.set(browserRequestId, controller)
          try {
            return await backend[method]({ ...payload, signal: controller.signal } as never)
          } finally {
            requests.delete(browserRequestId)
          }
        }
      ])
    ),
    [CANCEL_METHOD]: (input: { browserRequestId: string }) => {
      requests.get(input.browserRequestId)?.abort(new Error('Browser operation aborted'))
    }
  }
}

export function createRpcBrowserAutomationBackend(
  client: Pick<RpcClient, 'call'>
): BrowserAutomationToolBackend {
  return Object.fromEntries(
    BROWSER_AUTOMATION_TOOL_METHODS.map((method) => [
      method,
      async (input: Record<string, unknown>) => {
        const { signal: rawSignal, ...payload } = input
        const signal = rawSignal as AbortSignal | undefined
        signal?.throwIfAborted()
        if (!signal) return client.call(`${RPC_METHOD_PREFIX}${method}`, [payload])
        const browserRequestId = randomUUID()
        let rejectAborted!: (error: Error) => void
        const aborted = new Promise<never>((_, reject) => {
          rejectAborted = reject
        })
        const onAbort = (): void => {
          // Main abort invalidates and closes the actual session, not just this promise.
          void client.call(CANCEL_METHOD, [{ browserRequestId }]).catch(() => {})
          rejectAborted(new DOMException('Browser operation aborted', 'AbortError'))
        }
        const pending = client.call(`${RPC_METHOD_PREFIX}${method}`, [
          { ...payload, browserRequestId }
        ])
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        try {
          return await Promise.race([pending, aborted])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
    ])
  ) as unknown as BrowserAutomationToolBackend
}
