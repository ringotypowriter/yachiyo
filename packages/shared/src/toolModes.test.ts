import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from './protocol.ts'
import {
  EXPLORE_MODE_TOOL_NAMES,
  PLAN_MODE_TOOL_NAMES,
  RUN_MODE_DEFINITIONS,
  deriveRunModeId,
  normalizeRunModeId,
  resolveRunModeEnabledTools
} from './toolModes.ts'

test('run mode definitions expose expected tool sets', () => {
  assert.deepEqual(resolveRunModeEnabledTools('auto'), [...DEFAULT_ENABLED_TOOL_NAMES])
  assert.deepEqual(resolveRunModeEnabledTools('explore'), [...EXPLORE_MODE_TOOL_NAMES])
  assert.deepEqual(resolveRunModeEnabledTools('plan'), [...PLAN_MODE_TOOL_NAMES])
  assert.deepEqual(resolveRunModeEnabledTools('chat'), [])
})

test('deriveRunModeId recognizes standard modes independent of tool order', () => {
  assert.equal(deriveRunModeId(['webSearch', 'glob', 'read', 'webRead', 'grep']), 'explore')
  assert.equal(
    deriveRunModeId(['write', 'bash', 'webSearch', 'glob', 'read', 'webRead', 'grep']),
    'plan'
  )
  assert.equal(deriveRunModeId(resolveRunModeEnabledTools('auto')), 'auto')
  assert.equal(deriveRunModeId([]), 'chat')
})

test('deriveRunModeId falls back to auto for legacy custom tool sets', () => {
  assert.equal(deriveRunModeId(['read', 'bash']), 'auto')
})

test('normalizeRunModeId treats custom as a legacy invalid value', () => {
  assert.equal(normalizeRunModeId('explore'), 'explore')
  assert.equal(normalizeRunModeId('custom'), 'auto')
  assert.equal(normalizeRunModeId('custom', 'chat'), 'chat')
  assert.equal(normalizeRunModeId('plan', 'chat'), 'plan')
})

test('run mode definitions keep seasoning separate from tool availability', () => {
  assert.equal(RUN_MODE_DEFINITIONS.explore.seasoningKey, 'explore')
  assert.match(RUN_MODE_DEFINITIONS.explore.description, /Read.*search/)
})
