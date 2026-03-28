import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createGroupMonitor,
  GROUP_MONITOR_DEFAULTS,
  type GroupMonitorConfig
} from './groupMonitor.ts'
import type { GroupMessageEntry } from '../../../shared/yachiyo/protocol.ts'

function makeMessage(
  text: string,
  senderName = 'Alice',
  overrides: Partial<GroupMessageEntry> = {}
): GroupMessageEntry {
  return {
    senderName,
    senderExternalUserId: '123',
    isMention: false,
    text,
    timestamp: Date.now() / 1_000,
    ...overrides
  }
}

function fastConfig(overrides: Partial<GroupMonitorConfig> = {}): GroupMonitorConfig {
  return {
    ...GROUP_MONITOR_DEFAULTS,
    activeCheckIntervalMs: 50,
    engagedCheckIntervalMs: 30,
    wakeBufferMs: 20,
    dormancyMissCount: 2,
    disengageMissCount: 2,
    ...overrides
  }
}

describe('GroupMonitor', () => {
  it('starts in dormant phase', () => {
    const monitor = createGroupMonitor(fastConfig(), {
      onCheck: async () => ({ shouldReply: false, reason: 'test' }),
      onReply: async () => {},
      onStateChange: () => {}
    })

    assert.equal(monitor.getPhase(), 'dormant')
    monitor.stop()
  })

  it('buffers messages while dormant', () => {
    const monitor = createGroupMonitor(fastConfig({ wakeBufferMs: 5_000 }), {
      onCheck: async () => ({ shouldReply: false, reason: 'test' }),
      onReply: async () => {},
      onStateChange: () => {}
    })

    monitor.onMessage(makeMessage('one'))
    monitor.onMessage(makeMessage('two'))
    monitor.onMessage(makeMessage('three'))

    assert.equal(monitor.getRecentMessages().length, 3)
    assert.equal(monitor.getPhase(), 'dormant') // still buffering
    monitor.stop()
  })

  it('transitions to active after wake buffer', async () => {
    const phases: string[] = []
    const config = fastConfig({ wakeBufferMs: 30, activeCheckIntervalMs: 5_000 })
    const monitor = createGroupMonitor(config, {
      onCheck: async () => ({ shouldReply: false, reason: 'test' }),
      onReply: async () => {},
      onStateChange: (p) => phases.push(p)
    })

    monitor.onMessage(makeMessage('hello'))
    assert.equal(monitor.getPhase(), 'dormant')

    // Wait for wake buffer + a bit
    await new Promise((r) => setTimeout(r, 60))

    assert.ok(phases.includes('active'), `Expected 'active' in phases, got: ${phases}`)
    monitor.stop()
  })

  it('cleans up on stop', () => {
    const monitor = createGroupMonitor(fastConfig({ wakeBufferMs: 5_000 }), {
      onCheck: async () => ({ shouldReply: false, reason: 'test' }),
      onReply: async () => {},
      onStateChange: () => {}
    })

    monitor.onMessage(makeMessage('hello'))
    monitor.stop()

    assert.equal(monitor.getPhase(), 'dormant')
    assert.equal(monitor.getRecentMessages().length, 0)
  })

  it('respects maxRecentMessages limit', () => {
    const monitor = createGroupMonitor(fastConfig({ maxRecentMessages: 3, wakeBufferMs: 5_000 }), {
      onCheck: async () => ({ shouldReply: false, reason: 'test' }),
      onReply: async () => {},
      onStateChange: () => {}
    })

    for (let i = 0; i < 10; i++) {
      monitor.onMessage(makeMessage(`msg-${i}`))
    }

    assert.ok(monitor.getRecentMessages().length <= 3)
    monitor.stop()
  })
})
