import assert from 'node:assert/strict'
import test from 'node:test'

import { withInjectedEnv } from './injectedEnv.ts'
import { streamBashTool } from './bashTool.ts'

test('withInjectedEnv scopes YACHIYO_RUN_ID to the current tool-spawned process', () => {
  assert.deepEqual(withInjectedEnv({ PATH: '/bin' }, { runId: 'run-self' }), {
    PATH: '/bin',
    KAGETE_OVERLAY_LABEL: 'Yachiyo',
    YACHIYO_RUN_ID: 'run-self'
  })
})

test('withInjectedEnv removes a stale YACHIYO_RUN_ID when no current run is provided', () => {
  assert.deepEqual(withInjectedEnv({ PATH: '/bin', YACHIYO_RUN_ID: 'stale-run' }), {
    PATH: '/bin',
    KAGETE_OVERLAY_LABEL: 'Yachiyo'
  })
})

test('background bash forwards the current run id in its spawn environment', async () => {
  let forwardedRunId: string | undefined

  for await (const result of streamBashTool(
    {
      command: 'echo ok',
      description: 'verify the background run environment',
      timeout: 5,
      background: true
    },
    {
      runId: 'run-self',
      workspacePath: '/tmp/yachiyo',
      onBackgroundBashStarted: async (task) => {
        forwardedRunId = task.env?.YACHIYO_RUN_ID
      }
    }
  )) {
    assert.equal(result.details.background, true)
  }

  assert.equal(forwardedRunId, 'run-self')
})
