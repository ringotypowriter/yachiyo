import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUN_MODE_DEFINITIONS,
  deriveRunModeId,
  normalizeRunModeId,
  resolveRunModeEnabledTools
} from './toolModes.ts'

test('run mode definitions expose expected tool sets', () => {
  assert.deepEqual(resolveRunModeEnabledTools('auto'), [
    'read',
    'write',
    'edit',
    'bash',
    'jsRepl',
    'grep',
    'glob',
    'webRead',
    'useBrowser',
    'webSearch',
    'applyPatch',
    'useSentinel'
  ])
  assert.deepEqual(resolveRunModeEnabledTools('explore'), [
    'read',
    'grep',
    'glob',
    'webRead',
    'webSearch'
  ])
  assert.deepEqual(resolveRunModeEnabledTools('plan'), [
    'read',
    'grep',
    'glob',
    'webRead',
    'webSearch',
    'write',
    'bash'
  ])
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
