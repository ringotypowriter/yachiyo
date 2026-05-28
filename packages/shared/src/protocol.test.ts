import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveThreadCapabilities,
  getThreadCapabilities,
  isMemoryConfigured,
  isTrackedToolName
} from './protocol.ts'
import { CORE_TOOL_NAMES, DEFAULT_ENABLED_TOOL_NAMES } from './protocol.ts'

test('isMemoryConfigured follows the memory enabled flag', () => {
  assert.equal(isMemoryConfigured({ memory: { enabled: true } }), true)
  assert.equal(isMemoryConfigured({ memory: { enabled: false } }), false)
  assert.equal(isMemoryConfigured({}), false)
})

test('deriveThreadCapabilities disables retry and branch actions for ACP threads', () => {
  assert.deepEqual(deriveThreadCapabilities(), {
    canRetry: true,
    canCreateBranch: true,
    canSelectReplyBranch: true,
    canEdit: true,
    canDelete: true
  })

  assert.deepEqual(
    deriveThreadCapabilities({
      kind: 'acp',
      profileId: 'agent-1',
      sessionStatus: 'new'
    }),
    {
      canRetry: false,
      canCreateBranch: false,
      canSelectReplyBranch: false,
      canEdit: false,
      canDelete: false
    }
  )
})

test('getThreadCapabilities prefers explicit thread capabilities when present', () => {
  assert.deepEqual(
    getThreadCapabilities({
      runtimeBinding: { kind: 'acp', profileId: 'agent-1', sessionStatus: 'new' },
      capabilities: {
        canRetry: false,
        canCreateBranch: false,
        canSelectReplyBranch: false,
        canEdit: false,
        canDelete: false
      }
    }),
    {
      canRetry: false,
      canCreateBranch: false,
      canSelectReplyBranch: false,
      canEdit: false,
      canDelete: false
    }
  )
})

test('useBrowser is registered and enabled by default', () => {
  assert.ok(CORE_TOOL_NAMES.includes('useBrowser'))
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('useBrowser'))
})

test('delegateTask is the only registered delegation tool', () => {
  assert.ok(CORE_TOOL_NAMES.includes('delegateTask'))
  assert.equal(CORE_TOOL_NAMES.includes('delegateCodingTask' as never), false)
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('delegateTask'))
})

test('updateTodoList is a tracked runtime tool', () => {
  assert.ok(CORE_TOOL_NAMES.includes('updateTodoList'))
  assert.equal(isTrackedToolName('updateTodoList'), true)
})
