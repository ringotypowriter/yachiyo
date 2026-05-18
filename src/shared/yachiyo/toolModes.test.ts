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
    'webSearch'
  ])
  assert.deepEqual(resolveRunModeEnabledTools('explore'), [
    'read',
    'grep',
    'glob',
    'webRead',
    'webSearch'
  ])
  assert.deepEqual(resolveRunModeEnabledTools('chat'), [])
})

test('deriveRunModeId recognizes standard modes independent of tool order', () => {
  assert.equal(deriveRunModeId(['webSearch', 'glob', 'read', 'webRead', 'grep']), 'explore')
  assert.equal(deriveRunModeId(resolveRunModeEnabledTools('auto')), 'auto')
  assert.equal(deriveRunModeId([]), 'chat')
})

test('deriveRunModeId preserves legacy custom tool sets', () => {
  assert.equal(deriveRunModeId(['read', 'bash']), 'custom')
})

test('normalizeRunModeId accepts only selectable run modes plus custom fallback', () => {
  assert.equal(normalizeRunModeId('explore'), 'explore')
  assert.equal(normalizeRunModeId('custom'), 'custom')
  assert.equal(normalizeRunModeId('plan', 'chat'), 'chat')
})

test('run mode definitions keep seasoning separate from tool availability', () => {
  assert.equal(RUN_MODE_DEFINITIONS.explore.seasoningKey, 'explore')
  assert.match(RUN_MODE_DEFINITIONS.explore.description, /Read, search/)
})
