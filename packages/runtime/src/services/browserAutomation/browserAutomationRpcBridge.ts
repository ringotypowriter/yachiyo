import type { RpcClient } from '@yachiyo/shared/rpc/rpcClient'

import {
  BROWSER_AUTOMATION_TOOL_METHODS,
  type BrowserAutomationToolBackend
} from './browserAutomationToolBackend.ts'

/**
 * Bridges the tool-facing browser-automation surface across the RPC boundary:
 * the main process serves the live Electron-backed service via
 * createBrowserAutomationRpcTarget, and the runtime host (utility process)
 * injects createRpcBrowserAutomationBackend as the server's
 * browserAutomationService option. Method names are namespaced so the target
 * can share a transport with other main-process services.
 */
const RPC_METHOD_PREFIX = 'browserAutomation.'

export function createBrowserAutomationRpcTarget(
  backend: BrowserAutomationToolBackend
): Record<string, (input: never) => unknown> {
  return Object.fromEntries(
    BROWSER_AUTOMATION_TOOL_METHODS.map((method) => [
      `${RPC_METHOD_PREFIX}${method}`,
      (input: never) => backend[method](input)
    ])
  )
}

export function createRpcBrowserAutomationBackend(
  client: Pick<RpcClient, 'call'>
): BrowserAutomationToolBackend {
  return Object.fromEntries(
    BROWSER_AUTOMATION_TOOL_METHODS.map((method) => [
      method,
      (input: Record<string, unknown>) => {
        if (input['signal'] !== undefined) {
          // Cancellation must be redesigned as its own channel before anyone
          // starts passing signals; failing loudly beats dropping it.
          return Promise.reject(new Error('AbortSignal cannot cross the RPC boundary'))
        }
        return client.call(`${RPC_METHOD_PREFIX}${method}`, [input])
      }
    ])
  ) as unknown as BrowserAutomationToolBackend
}
