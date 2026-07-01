import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  telegramPolicy,
  resolveChannelPolicy,
  applyChannelsConfigToPolicy
} from './channelPolicy.ts'

describe('telegramPolicy', () => {
  it('has the correct platform', () => {
    assert.equal(telegramPolicy.platform, 'telegram')
  })

  it('includes only read-only safe tools', () => {
    const tools = telegramPolicy.allowedTools
    assert.ok(tools.includes('read'))
    assert.ok(tools.includes('grep'))
    assert.ok(tools.includes('glob'))
    assert.ok(tools.includes('webRead'))
    assert.ok(tools.includes('webSearch'))
    assert.ok(!tools.includes('bash'))
    assert.ok(!tools.includes('edit'))
    assert.ok(!tools.includes('write'))
  })

  it('extracts reply from tagged output', () => {
    const raw = 'Some thinking... <reply>Hello there!</reply>'
    assert.equal(telegramPolicy.extractVisibleReply(raw), 'Hello there!')
  })

  it('falls back to full text when no reply tags', () => {
    const raw = 'Just a plain response'
    assert.equal(telegramPolicy.extractVisibleReply(raw), 'Just a plain response')
  })
})

describe('resolveChannelPolicy', () => {
  it('resolves telegram to telegramPolicy', () => {
    const policy = resolveChannelPolicy('telegram')
    assert.equal(policy, telegramPolicy)
  })

  it('throws for unknown platform', () => {
    assert.throws(() => resolveChannelPolicy('unknown' as 'telegram'), /Unknown channel platform/)
  })
})

describe('applyChannelsConfigToPolicy group handoff threshold', () => {
  it('defaults the handoff threshold to 2× the window (hysteresis)', () => {
    const policy = applyChannelsConfigToPolicy(telegramPolicy, { groupContextWindowK: 32 })
    assert.equal(policy.groupContextTokenLimit, 32_000)
    assert.equal(policy.groupHandoffTokenThreshold, 64_000)
  })

  it('floors an explicit threshold at 2× the window so it never re-summarizes every turn', () => {
    const policy = applyChannelsConfigToPolicy(telegramPolicy, {
      groupContextWindowK: 32,
      groupHandoffThresholdK: 32 // below 2× window → floored to 64K
    })
    assert.equal(policy.groupHandoffTokenThreshold, 64_000)
  })

  it('honors an explicit threshold above the floor', () => {
    const policy = applyChannelsConfigToPolicy(telegramPolicy, {
      groupContextWindowK: 32,
      groupHandoffThresholdK: 128
    })
    assert.equal(policy.groupHandoffTokenThreshold, 128_000)
  })
})
