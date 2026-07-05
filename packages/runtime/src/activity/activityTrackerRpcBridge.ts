import type { RpcClient } from '@yachiyo/shared/rpc/rpcClient'

import type { ActivitySummary, ActivitySummarySource } from './ActivityTracker.ts'

/**
 * Bridges ActivitySummarySource across the RPC boundary: the tracker stays in
 * the main process next to powerMonitor/BrowserWindow, and the runtime host
 * (utility process) consumes summaries through this proxy instead of its own
 * empty per-process singleton.
 */
const RPC_METHOD = 'activityTracker.finalizeAndConsume'

export function createActivityTrackerRpcTarget(
  source: ActivitySummarySource
): Record<string, () => ActivitySummary | null | Promise<ActivitySummary | null>> {
  return { [RPC_METHOD]: () => source.finalizeAndConsume() }
}

export function createRpcActivitySummarySource(
  client: Pick<RpcClient, 'call'>
): ActivitySummarySource {
  return {
    finalizeAndConsume: async () => (await client.call(RPC_METHOD, [])) as ActivitySummary | null
  }
}
