import assert from 'node:assert/strict'
import test from 'node:test'

import { hasEnabledChatModel, LAUNCH_AT_LOGIN_PROMPT } from './behaviorPaneModel.ts'

test('hasEnabledChatModel returns false when no providers are configured', () => {
  assert.equal(hasEnabledChatModel([]), false)
})

test('hasEnabledChatModel returns false when providers have no enabled models', () => {
  assert.equal(
    hasEnabledChatModel([
      { modelList: { enabled: [], disabled: ['gpt-5'] } },
      { modelList: { enabled: [], disabled: [] } }
    ]),
    false
  )
})

test('hasEnabledChatModel returns true when any provider has an enabled model', () => {
  assert.equal(
    hasEnabledChatModel([
      { modelList: { enabled: [], disabled: [] } },
      { modelList: { enabled: ['gpt-5'], disabled: [] } }
    ]),
    true
  )
})

test('launch at login prompt stays concise and delegates details to the skill', () => {
  assert.equal(
    LAUNCH_AT_LOGIN_PROMPT,
    'Set up Yachiyo to launch automatically when I log in on macOS.'
  )
})
