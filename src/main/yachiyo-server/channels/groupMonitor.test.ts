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
      onTurn: async () => false,
      onStateChange: () => {}
    })

    assert.equal(monitor.getPhase(), 'dormant')
    monitor.stop()
  })

  it('buffers messages while dormant', () => {
    const monitor = createGroupMonitor(fastConfig({ wakeBufferMs: 5_000 }), {
      onTurn: async () => false,
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
      onTurn: async () => false,
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
      onTurn: async () => false,
      onStateChange: () => {}
    })

    monitor.onMessage(makeMessage('hello'))
    monitor.stop()

    assert.equal(monitor.getPhase(), 'dormant')
    assert.equal(monitor.getRecentMessages().length, 0)
  })

  it('respects maxRecentMessages limit', () => {
    const monitor = createGroupMonitor(fastConfig({ maxRecentMessages: 3, wakeBufferMs: 5_000 }), {
      onTurn: async () => false,
      onStateChange: () => {}
    })

    for (let i = 0; i < 10; i++) {
      monitor.onMessage(makeMessage(`msg-${i}`))
    }

    assert.ok(monitor.getRecentMessages().length <= 3)
    monitor.stop()
  })

  it('getSnapshot returns current phase and buffer copy', () => {
    const monitor = createGroupMonitor(fastConfig({ wakeBufferMs: 5_000 }), {
      onTurn: async () => false,
      onStateChange: () => {}
    })

    monitor.onMessage(makeMessage('one'))
    monitor.onMessage(makeMessage('two'))

    const snapshot = monitor.getSnapshot()
    assert.equal(snapshot.phase, 'dormant')
    assert.equal(snapshot.buffer.length, 2)
    assert.equal(snapshot.buffer[0].text, 'one')
    // Verify it's a copy, not a reference
    snapshot.buffer.push(makeMessage('three'))
    assert.equal(monitor.getRecentMessages().length, 2)
    monitor.stop()
  })

  it('restores buffer from restoreState', () => {
    const now = Date.now() / 1_000
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('restored-1', 'Alice', { timestamp: now - 60 }),
      makeMessage('restored-2', 'Bob', { timestamp: now - 30 })
    ]

    const monitor = createGroupMonitor(
      fastConfig({ wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'active', buffer: restoredMessages }
    )

    // Buffer is restored
    assert.equal(monitor.getRecentMessages().length, 2)
    assert.equal(monitor.getRecentMessages()[0].text, 'restored-1')
    // Always starts dormant regardless of saved phase
    assert.equal(monitor.getPhase(), 'dormant')
    monitor.stop()
  })

  it('keeps stale restored messages (time-prune disabled for restored context)', () => {
    const staleTimestamp = Date.now() / 1_000 - 999_999
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('old', 'Alice', { timestamp: staleTimestamp }),
      makeMessage('recent', 'Bob', { timestamp: Date.now() / 1_000 })
    ]

    const monitor = createGroupMonitor(
      fastConfig({ wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    // Both messages survive — restored messages are exempt from time-based eviction
    assert.equal(monitor.getRecentMessages().length, 2)
    assert.equal(monitor.getRecentMessages()[0].text, 'old')
    assert.equal(monitor.getRecentMessages()[1].text, 'recent')
    monitor.stop()
  })

  it('restored messages get displaced by count cap as new messages arrive', () => {
    const staleTimestamp = Date.now() / 1_000 - 999_999
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('old-1', 'Alice', { timestamp: staleTimestamp }),
      makeMessage('old-2', 'Bob', { timestamp: staleTimestamp + 1 })
    ]

    const monitor = createGroupMonitor(
      fastConfig({ maxRecentMessages: 3, wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    assert.equal(monitor.getRecentMessages().length, 2)

    // Add 2 new messages → exceeds maxRecentMessages (3), pushes out old restored
    monitor.onMessage(makeMessage('new-1'))
    monitor.onMessage(makeMessage('new-2'))

    const msgs = monitor.getRecentMessages()
    assert.equal(msgs.length, 3)
    assert.equal(msgs[0].text, 'old-2') // old-1 displaced by count cap
    assert.equal(msgs[1].text, 'new-1')
    assert.equal(msgs[2].text, 'new-2')
    monitor.stop()
  })

  it('time-based pruning resumes after all restored messages are displaced', () => {
    const staleTimestamp = Date.now() / 1_000 - 999_999
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('old', 'Alice', { timestamp: staleTimestamp })
    ]

    const monitor = createGroupMonitor(
      fastConfig({ maxRecentMessages: 2, wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    // Push 2 new messages → count cap displaces the restored one
    monitor.onMessage(makeMessage('new-1'))
    monitor.onMessage(makeMessage('new-2'))

    const msgs = monitor.getRecentMessages()
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].text, 'new-1')
    assert.equal(msgs[1].text, 'new-2')
    // restored message is gone → time-based pruning would now work normally
    monitor.stop()
  })

  it('time-prunes aged-out new messages even while restored messages exist', () => {
    const staleTimestamp = Date.now() / 1_000 - 999_999
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('restored', 'Alice', { timestamp: staleTimestamp })
    ]

    // Use a very short window so new messages age out quickly.
    const monitor = createGroupMonitor(
      fastConfig({ recentMessageWindowMs: 1, wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    // Add a new message with an already-stale timestamp.
    const agedTimestamp = Date.now() / 1_000 - 10
    monitor.onMessage(makeMessage('aged-new', 'Bob', { timestamp: agedTimestamp }))

    // The restored message stays (protected), but the aged new message is evicted.
    const msgs = monitor.getRecentMessages()
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].text, 'restored')
    monitor.stop()
  })

  it('restored messages are treated as already seen', async () => {
    const turnCalls: number[] = []
    const now = Date.now() / 1_000
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('old-msg', 'Alice', { timestamp: now - 5 })
    ]

    const config = fastConfig({ wakeBufferMs: 10, activeCheckIntervalMs: 5_000 })
    const monitor = createGroupMonitor(
      config,
      {
        onTurn: async (msgs) => {
          turnCalls.push(msgs.length)
          return false
        },
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    // Send a new message to trigger wake → active → check
    monitor.onMessage(makeMessage('new-msg', 'Bob'))

    // Wait for wake buffer + check
    await new Promise((r) => setTimeout(r, 80))

    // onTurn should have been called; the buffer should include both messages
    // but the key thing is it should actually fire (not skip due to "no new messages")
    assert.ok(turnCalls.length > 0, 'onTurn should have been called')
    monitor.stop()
  })
})
