import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getThreadPlanDocumentFilename,
  hasExitPlanModeToolCall,
  isLatestRunPlanMode,
  normalizePlanDocumentFilename,
  PLAN_DOCUMENT_DIR_NAME,
  PLAN_MODE_EXIT_TOOL_NAME
} from './planMode.ts'

test('normalizePlanDocumentFilename accepts only plan document filenames', () => {
  assert.equal(normalizePlanDocumentFilename('plan-abcdef.md\n'), 'plan-abcdef.md')
  assert.equal(normalizePlanDocumentFilename('PLAN-ABCDEF.md'), 'plan-abcdef.md')
  assert.equal(normalizePlanDocumentFilename('plan-thread_123.md'), 'plan-thread_123.md')
  assert.equal(normalizePlanDocumentFilename('plan-fixed.md'), 'plan-fixed.md')
  assert.equal(normalizePlanDocumentFilename('../plan-abcdef.md'), null)
})

test('getThreadPlanDocumentFilename derives a stable random-looking filename from the thread id', () => {
  assert.equal(getThreadPlanDocumentFilename('Thread_123'), 'plan-midkeavc.md')
  assert.equal(getThreadPlanDocumentFilename('thread:abc/def'), 'plan-dzhsvrzk.md')
  assert.equal(
    getThreadPlanDocumentFilename('Thread_123'),
    getThreadPlanDocumentFilename('thread_123')
  )
})

test('plan document constants keep plan files in the workspace metadata directory', () => {
  assert.equal(PLAN_DOCUMENT_DIR_NAME, '.yachiyo')
})

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
