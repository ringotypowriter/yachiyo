import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createGroupMonitor,
  GROUP_MONITOR_DEFAULTS,
  type GroupMonitorConfig
} from './groupMonitor.ts'
import { formatGroupProbeTurnDelta } from './groupContextBuilder.ts'
import type { GroupMessageEntry } from '@yachiyo/shared/protocol'

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
  it('waits asynchronously for pending images when mentioned in either mode', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    for (const mode of ['probe', 'mention'] as const) {
      let turns = 0
      const monitor = createGroupMonitor(fastConfig({ mode }), {
        onTurn: async () => {
          turns++
          return false
        },
        onStateChange: () => {}
      })
      t.after(() => monitor.stop())
      const image = makeMessage('picture', 'Alice', { enrichmentPending: true })
      monitor.onMessage(image)
      monitor.onMessage(makeMessage('question', 'Bob', { isMention: true }))
      assert.equal(turns, 0)
      image.enrichmentPending = false
      t.mock.timers.tick(100)
      await Promise.resolve()
      assert.equal(turns, 1)
      monitor.stop()
    }
  })

  it('admits deferred image-only context on mention without processing it on ordinary activity', async (t) => {
    const turns: GroupMessageEntry[][] = []
    const monitor = createGroupMonitor(fastConfig({ mode: 'mention' }), {
      onTurn: async (messages) => {
        turns.push(messages)
        return false
      },
      onStateChange: () => {}
    })
    t.after(() => monitor.stop())
    monitor.onMessage(
      makeMessage('', 'Alice', {
        imageDescriptionDeferred: true,
        images: [{ dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png' }]
      })
    )
    assert.equal(turns.length, 0)
    monitor.onMessage(makeMessage('look', 'Alice', { isMention: true }))
    await Promise.resolve()
    assert.equal(turns[0].length, 2)
  })

  it('only runs on mentions, retaining up to 100 messages without a short time cutoff', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const turns: string[][] = []
    const monitor = createGroupMonitor(
      fastConfig({ mode: 'mention', maxRecentMessages: 100, recentMessageWindowMs: Infinity }),
      {
        onTurn: async (messages, freshCount) => {
          turns.push(messages.slice(-freshCount).map((m) => m.text))
          return true
        },
        onStateChange: () => {}
      }
    )
    t.after(() => monitor.stop())
    for (let i = 0; i < 110; i++) {
      monitor.onMessage(
        makeMessage(`background ${i}`, 'Alice', { timestamp: Date.now() / 1000 - 3600 })
      )
    }
    t.mock.timers.tick(60_000)
    assert.equal(turns.length, 0)
    monitor.onMessage(makeMessage('question', 'Alice', { isMention: true }))
    await Promise.resolve()
    assert.equal(turns[0].length, 100)
    assert.equal(turns[0][0], 'background 11')
    monitor.onMessage(makeMessage('ordinary follow-up'))
    t.mock.timers.tick(60_000)
    assert.equal(turns.length, 1)
    monitor.onMessage(makeMessage('next question', 'Alice', { isMention: true }))
    await Promise.resolve()
    assert.deepEqual(turns[1], ['ordinary follow-up', 'next question'])
  })

  it('drains mentions received during a turn without auto-following ordinary messages', async (t) => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const turns: string[][] = []
    const monitor = createGroupMonitor(fastConfig({ mode: 'mention' }), {
      onTurn: async (messages, freshCount) => {
        turns.push(messages.slice(-freshCount).map((m) => m.text))
        if (turns.length === 1) await blocked
        return true
      },
      onStateChange: () => {}
    })
    t.after(() => monitor.stop())
    monitor.onMessage(makeMessage('first', 'Alice', { isMention: true }))
    monitor.onMessage(makeMessage('second', 'Bob', { isMention: true }))
    release()
    await blocked
    await Promise.resolve()
    assert.deepEqual(turns, [['first'], ['second']])
  })

  it('switches trigger mode without clearing the buffer or replaying consumed messages', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const turns: string[][] = []
    const monitor = createGroupMonitor(fastConfig({ mode: 'mention' }), {
      onTurn: async (messages, freshCount) => {
        turns.push(messages.slice(-freshCount).map((m) => m.text))
        return true
      },
      onStateChange: () => {}
    })
    t.after(() => monitor.stop())
    monitor.onMessage(makeMessage('first', 'Alice', { isMention: true }))
    await Promise.resolve()
    monitor.onMessage(makeMessage('background'))
    monitor.setMode('probe')
    t.mock.timers.tick(50)
    await Promise.resolve()
    assert.deepEqual(turns, [['first'], ['background']])
    monitor.setMode('mention')
    monitor.onMessage(makeMessage('later'))
    t.mock.timers.tick(60_000)
    assert.equal(turns.length, 2)
    monitor.onMessage(makeMessage('third', 'Alice', { isMention: true }))
    await Promise.resolve()
    assert.deepEqual(turns[2], ['later', 'third'])
    assert.equal(monitor.getRecentMessages().length, 4)
  })

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

  it('evicts stale restored messages on restore', () => {
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

    // Stale message is evicted; only the recent one survives
    assert.equal(monitor.getRecentMessages().length, 1)
    assert.equal(monitor.getRecentMessages()[0].text, 'recent')
    monitor.stop()
  })

  it('stale restored messages are evicted by time, not just count', () => {
    const staleTimestamp = Date.now() / 1_000 - 999_999
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('old-1', 'Alice', { timestamp: staleTimestamp }),
      makeMessage('old-2', 'Bob', { timestamp: staleTimestamp + 1 })
    ]

    const monitor = createGroupMonitor(
      fastConfig({ maxRecentMessages: 10, wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    // Both stale messages evicted on restore — no need for count displacement
    assert.equal(monitor.getRecentMessages().length, 0)
    monitor.stop()
  })

  it('recent restored messages survive time-based eviction', () => {
    const now = Date.now() / 1_000
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('still-fresh', 'Alice', { timestamp: now - 60 }),
      makeMessage('also-fresh', 'Bob', { timestamp: now - 30 })
    ]

    const monitor = createGroupMonitor(
      fastConfig({ wakeBufferMs: 5_000 }),
      {
        onTurn: async () => false,
        onStateChange: () => {}
      },
      { phase: 'dormant', buffer: restoredMessages }
    )

    // Both within the 10-minute window — they survive
    assert.equal(monitor.getRecentMessages().length, 2)
    assert.equal(monitor.getRecentMessages()[0].text, 'still-fresh')
    assert.equal(monitor.getRecentMessages()[1].text, 'also-fresh')
    monitor.stop()
  })

  it('time-prunes aged-out new messages after restore', () => {
    const now = Date.now() / 1_000
    const restoredMessages: GroupMessageEntry[] = [
      makeMessage('restored', 'Alice', { timestamp: now - 30 })
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

    // Restored message is also stale under the 1ms window — buffer is empty
    assert.equal(monitor.getRecentMessages().length, 0)

    // Add a new message with an already-stale timestamp.
    const agedTimestamp = Date.now() / 1_000 - 10
    monitor.onMessage(makeMessage('aged-new', 'Bob', { timestamp: agedTimestamp }))

    // The aged new message is also evicted.
    assert.equal(monitor.getRecentMessages().length, 0)
    monitor.stop()
  })

  it('survives onTurn throwing — logs error and continues next check', async () => {
    const turnCalls: number[] = []
    const phases: string[] = []
    let failCount = 0

    const config = fastConfig({ wakeBufferMs: 10, activeCheckIntervalMs: 40 })
    const monitor = createGroupMonitor(config, {
      onTurn: async (msgs) => {
        turnCalls.push(msgs.length)
        if (failCount < 1) {
          failCount++
          throw new Error('API down')
        }
        return false
      },
      onStateChange: (p) => phases.push(p)
    })

    // Send a message to trigger wake → active → first check (which throws)
    monitor.onMessage(makeMessage('hello'))

    // Wait for wake buffer + first failed check
    await new Promise((r) => setTimeout(r, 60))

    assert.ok(turnCalls.length >= 1, `Expected at least 1 onTurn call, got ${turnCalls.length}`)

    // Send another message so the next check interval sees fresh content
    monitor.onMessage(makeMessage('world'))

    // Wait for next check interval
    await new Promise((r) => setTimeout(r, 80))

    // onTurn should have been called again despite the earlier throw
    assert.ok(turnCalls.length >= 2, `Expected at least 2 onTurn calls, got ${turnCalls.length}`)
    // Monitor should still be in a valid phase (not stuck)
    assert.ok(
      ['active', 'dormant'].includes(monitor.getPhase()),
      `Expected active or dormant, got ${monitor.getPhase()}`
    )
    monitor.stop()
  })

  it('does not change phase when onTurn throws', async () => {
    const phases: string[] = []

    const config = fastConfig({ wakeBufferMs: 10, activeCheckIntervalMs: 30 })
    const monitor = createGroupMonitor(config, {
      onTurn: async () => {
        throw new Error('network error')
      },
      onStateChange: (p) => phases.push(p)
    })

    monitor.onMessage(makeMessage('trigger'))

    // Wait for wake + a check
    await new Promise((r) => setTimeout(r, 80))

    // Should have transitioned to active (from wake), but NOT to engaged or dormant
    // because the onTurn error should not affect phase transitions
    assert.ok(phases.includes('active'), `Expected 'active' in phases, got: ${phases}`)
    assert.ok(!phases.includes('engaged'), `Should not be engaged when onTurn always throws`)
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

  it('delays probing while fresh image descriptions are pending', async () => {
    const turnCalls: GroupMessageEntry[][] = []
    const config = fastConfig({
      wakeBufferMs: 10,
      activeCheckIntervalMs: 30,
      dormancyMissCount: 10
    })
    const entry = makeMessage('look', 'Alice', {
      enrichmentPending: true,
      images: [{ dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' }]
    })
    const monitor = createGroupMonitor(config, {
      onTurn: async (messages) => {
        turnCalls.push(messages)
        return false
      },
      onStateChange: () => {}
    })

    monitor.onMessage(entry)
    await new Promise((r) => setTimeout(r, 70))

    assert.equal(turnCalls.length, 0)

    entry.enrichmentPending = false
    entry.images = [
      { dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png', altText: 'a cat' }
    ]
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(turnCalls.length, 1)
    assert.equal(turnCalls[0][0].images?.[0]?.altText, 'a cat')
    monitor.stop()
  })

  it('does not probe image-only messages after description failure', async () => {
    let turnCalls = 0
    const config = fastConfig({
      wakeBufferMs: 10,
      activeCheckIntervalMs: 30,
      dormancyMissCount: 10
    })
    const entry = makeMessage('', 'Alice', {
      enrichmentPending: true,
      images: [{ dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' }]
    })
    const monitor = createGroupMonitor(config, {
      onTurn: async () => {
        turnCalls++
        return false
      },
      onStateChange: () => {}
    })

    monitor.onMessage(entry)
    await new Promise((r) => setTimeout(r, 70))

    assert.equal(turnCalls, 0)

    entry.enrichmentPending = false
    entry.images = []
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(turnCalls, 0)
    monitor.stop()
  })
})

describe('GroupMonitor self-message handling (#55)', () => {
  const selfMessage = (text: string): GroupMessageEntry =>
    makeMessage(text, 'Yachiyo', { senderExternalUserId: '__self__' })

  it('self line survives a self-only tick and lands in the next real turn', async () => {
    const turns: Array<{ count: number; prompt: string }> = []
    const config = fastConfig({ wakeBufferMs: 10, activeCheckIntervalMs: 25 })
    const monitor = createGroupMonitor(
      config,
      {
        onTurn: async (msgs, freshCount) => {
          turns.push({
            count: freshCount,
            prompt: formatGroupProbeTurnDelta(msgs, 'Yachiyo', undefined, undefined, freshCount)
          })
          return false
        },
        onStateChange: () => {}
      },
      { phase: 'active', buffer: [] }
    )

    // Yachiyo speaks; the next tick(s) are self-only and must not consume it.
    monitor.onMessage(selfMessage('我刚说的话'))
    await new Promise((r) => setTimeout(r, 70))
    assert.equal(turns.length, 0, 'self-only ticks must not trigger a probe turn')

    // A human replies — the turn must include the unconsumed self line.
    monitor.onMessage(makeMessage('回复她', 'Bob'))
    await new Promise((r) => setTimeout(r, 70))

    assert.ok(turns.length > 0, 'human message should trigger a turn')
    assert.equal(turns[0].count, 2, 'freshCount must count self + human (render window)')
    assert.match(turns[0].prompt, /<msg from="Yachiyo"[^>]*>我刚说的话<\/msg>/)
    assert.match(turns[0].prompt, /<msg from="Bob"[^>]*>回复她<\/msg>/)
    assert.ok(
      turns[0].prompt.indexOf('我刚说的话') < turns[0].prompt.indexOf('回复她'),
      'the model context must keep the actual sent line before the human reply'
    )
    monitor.stop()
  })

  it('self-only tail does not stall dormancy accounting', async () => {
    const config = fastConfig({ wakeBufferMs: 10, activeCheckIntervalMs: 20, dormancyMissCount: 2 })
    const phases: string[] = []
    const monitor = createGroupMonitor(
      config,
      {
        onTurn: async () => false,
        onStateChange: (p) => phases.push(p)
      },
      { phase: 'active', buffer: [] }
    )

    monitor.onMessage(selfMessage('无人回应的话'))
    // Two+ self-only ticks: misses must accumulate and put the monitor to
    // sleep instead of spinning forever on the unconsumed self tail.
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(monitor.getPhase(), 'dormant', 'monitor must go dormant despite self tail')
    monitor.stop()
  })

  it('restored trailing self line survives restart into the next real turn (#55 P1)', async () => {
    const now = Date.now() / 1_000
    const turns: Array<{ count: number; prompt: string }> = []
    const config = fastConfig({ wakeBufferMs: 10, activeCheckIntervalMs: 5_000 })
    const monitor = createGroupMonitor(
      config,
      {
        onTurn: async (msgs, freshCount) => {
          turns.push({
            count: freshCount,
            prompt: formatGroupProbeTurnDelta(msgs, 'Yachiyo', undefined, undefined, freshCount)
          })
          return false
        },
        onStateChange: () => {}
      },
      {
        phase: 'dormant',
        buffer: [
          makeMessage('older human line', 'Alice', { timestamp: now - 20 }),
          makeMessage('重启前我说的话', 'Yachiyo', {
            senderExternalUserId: '__self__',
            timestamp: now - 5
          })
        ]
      }
    )

    // After restart, Bob replies — the prompt window must still carry the
    // unconsumed self line (the old human line stays seen, as designed).
    monitor.onMessage(makeMessage('回她的话', 'Bob'))
    await new Promise((r) => setTimeout(r, 80))

    assert.ok(turns.length > 0, 'turn should fire on the human reply')
    assert.equal(turns[0].count, 2, 'freshCount = restored self line + new human line')
    assert.match(turns[0].prompt, /<msg from="Yachiyo"[^>]*>重启前我说的话<\/msg>/)
    assert.match(turns[0].prompt, /<msg from="Bob"[^>]*>回她的话<\/msg>/)
    assert.ok(
      turns[0].prompt.indexOf('重启前我说的话') < turns[0].prompt.indexOf('回她的话'),
      'restart must preserve the actual sent line before the human reply'
    )
    monitor.stop()
  })
})
