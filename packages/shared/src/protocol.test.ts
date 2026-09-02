import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveThreadCapabilities,
  getThreadCapabilities,
  isMemoryConfigured,
  isTrackedToolName,
  normalizeEnabledTools
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

test('pyRepl is registered and enabled by default', () => {
  assert.ok(CORE_TOOL_NAMES.includes('pyRepl'))
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('pyRepl'))
})

test('thread messaging and task lifecycle tools are registered and enabled by default', () => {
  assert.ok(CORE_TOOL_NAMES.includes('sendThreadMessage'))
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('sendThreadMessage'))
  assert.ok(CORE_TOOL_NAMES.includes('delegateTask'))
  assert.ok(CORE_TOOL_NAMES.includes('steerTask'))
  assert.ok(CORE_TOOL_NAMES.includes('getTask'))
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('delegateTask'))
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('steerTask'))
  assert.ok(DEFAULT_ENABLED_TOOL_NAMES.includes('getTask'))
  assert.equal(CORE_TOOL_NAMES.includes('sendMessage' as never), false)
})

test('legacy sendMessage settings migrate to task lifecycle tools', () => {
  assert.deepEqual(normalizeEnabledTools(['read', 'sendMessage']), ['read', 'steerTask', 'getTask'])
})

test('delegateTask is the only registered task creation tool', () => {
  assert.equal(CORE_TOOL_NAMES.includes('delegateCodingTask' as never), false)
})

test('updateTodoList is a core tool but not tracked in the timeline', () => {
  assert.ok(CORE_TOOL_NAMES.includes('updateTodoList'))
  assert.equal(isTrackedToolName('updateTodoList'), false)
})
