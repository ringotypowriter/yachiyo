import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasExitPlanModeToolCall,
  isLatestRunPlanMode,
  PLAN_MODE_EXIT_TOOL_NAME
} from './planMode.ts'

test('hasExitPlanModeToolCall detects nested AI SDK tool-call content', () => {
  assert.equal(
    hasExitPlanModeToolCall([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: PLAN_MODE_EXIT_TOOL_NAME,
            toolCallId: 'call-1'
          }
        ]
      }
    ]),
    true
  )
})

test('hasExitPlanModeToolCall ignores unrelated tool calls', () => {
  assert.equal(
    hasExitPlanModeToolCall([
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'write' }] }
    ]),
    false
  )
})

test('isLatestRunPlanMode detects the latest run from its request message turn context', () => {
  assert.equal(
    isLatestRunPlanMode({
      latestRun: { requestMessageId: 'user-1' },
      messages: [{ id: 'user-1', turnContext: { runMode: 'plan' } }]
    }),
    true
  )
})

test('isLatestRunPlanMode accepts live run records with runMode metadata', () => {
  assert.equal(
    isLatestRunPlanMode({
      latestRun: { requestMessageId: 'user-live', runMode: 'plan' },
      messages: []
    }),
    true
  )
})

test('isLatestRunPlanMode ignores older plan messages and missing request metadata', () => {
  assert.equal(
    isLatestRunPlanMode({
      latestRun: { requestMessageId: 'user-2' },
      messages: [
        { id: 'user-1', turnContext: { runMode: 'plan' } },
        { id: 'user-2', turnContext: { runMode: 'auto' } }
      ]
    }),
    false
  )

  assert.equal(isLatestRunPlanMode({ latestRun: null, messages: [] }), false)
})
