import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

import {
  createActivityTrackerRpcTarget,
  createRpcActivitySummarySource
} from './activityTrackerRpcBridge.ts'
import type { ActivitySummary } from './ActivityTracker.ts'

const SUMMARY: ActivitySummary = {
  text: 'Worked in Zed for 5 minutes',
  startedAt: '2026-07-05T00:00:00.000Z',
  endedAt: '2026-07-05T00:05:00.000Z',
  totalDurationMs: 300_000,
  uniqueApps: 1,
  entries: [{ appName: 'Zed', bundleId: 'dev.zed.Zed', durationMs: 300_000 }]
}

test('forwards finalizeAndConsume across the RPC boundary', async () => {
  let consumed = 0
  const [mainTransport, utilityTransport] = createLoopbackTransportPair()
  serveRpcTarget({
    transport: mainTransport,
    target: createActivityTrackerRpcTarget({
      finalizeAndConsume: () => {
        consumed += 1
        return consumed === 1 ? SUMMARY : null
      }
    })
  })
  const source = createRpcActivitySummarySource(createRpcClient(utilityTransport))

  assert.deepEqual(await source.finalizeAndConsume(), SUMMARY)
  assert.equal(await source.finalizeAndConsume(), null)
  assert.equal(consumed, 2)
})
