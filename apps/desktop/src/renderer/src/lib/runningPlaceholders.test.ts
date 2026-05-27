import assert from 'node:assert/strict'
import test from 'node:test'

import {
  THINKING_SIDEBAR_PREVIEWS,
  WORKING_SIDEBAR_PREVIEWS,
  pickSidebarPlaceholder,
  makeRunningPlaceholderSeed
} from './runningPlaceholders.ts'

test('pickSidebarPlaceholder returns a deterministic label for a given seed', () => {
  const label1 = pickSidebarPlaceholder('run:abc123:thinking', THINKING_SIDEBAR_PREVIEWS)
  const label2 = pickSidebarPlaceholder('run:abc123:thinking', THINKING_SIDEBAR_PREVIEWS)
  assert.equal(label1, label2)
  assert.ok(THINKING_SIDEBAR_PREVIEWS.includes(label1))
})

test('pickSidebarPlaceholder returns different labels for different seeds', () => {
  const label1 = pickSidebarPlaceholder('run:abc123:thinking', THINKING_SIDEBAR_PREVIEWS)
  const label2 = pickSidebarPlaceholder('run:def456:thinking', THINKING_SIDEBAR_PREVIEWS)
  assert.notEqual(label1, label2)
})

test('makeRunningPlaceholderSeed uses run id when present', () => {
  assert.equal(makeRunningPlaceholderSeed('run-1', 'thread-1', 'thinking'), 'run:run-1:thinking')
})

test('makeRunningPlaceholderSeed falls back to thread id when run id is null', () => {
  assert.equal(makeRunningPlaceholderSeed(null, 'thread-1', 'working'), 'thread:thread-1:working')
})

test('THINKING_SIDEBAR_PREVIEWS entries all end with ellipsis', () => {
  for (const label of THINKING_SIDEBAR_PREVIEWS) {
    assert.ok(label.endsWith('...'), `expected ${label} to end with ...`)
  }
})

test('WORKING_SIDEBAR_PREVIEWS entries all end with ellipsis', () => {
  for (const label of WORKING_SIDEBAR_PREVIEWS) {
    assert.ok(label.endsWith('...'), `expected ${label} to end with ...`)
  }
})
