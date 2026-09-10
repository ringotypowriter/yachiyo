import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupMonitorRegistry } from './groupMonitorRegistry.ts'
import { qqPolicy } from '../shared/channelPolicy.ts'

test('a live mode switch preserves the 100-entry context window and incremental cursor', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const turns: string[][] = []
  const registry = createGroupMonitorRegistry(
    qqPolicy.groupDefaults,
    { enabled: true, mode: 'mention' },
    {
      onTurn: async (_group, messages, count) => {
        turns.push(messages.slice(-count).map((m) => m.text))
        return false
      },
      onStateChange: () => {}
    }
  )
  t.after(() => registry.stopAll())
  registry.startMonitor({
    id: 'g',
    platform: 'qq',
    externalGroupId: '123',
    name: 'Group',
    label: '',
    status: 'approved',
    workspacePath: '/tmp',
    createdAt: ''
  })
  for (let i = 0; i < 100; i++) {
    registry.routeMessage('g', {
      senderName: 'Alice',
      senderExternalUserId: '1',
      text: String(i),
      isMention: false,
      timestamp: Date.now() / 1000 - 3600
    })
  }
  registry.setMode('probe')
  t.mock.timers.tick(30_000)
  await Promise.resolve()
  assert.equal(turns[0]?.length, 100)
  registry.setMode('mention')
  registry.routeMessage('g', {
    senderName: 'Bob',
    senderExternalUserId: '2',
    text: 'question',
    isMention: true,
    timestamp: Date.now() / 1000
  })
  await Promise.resolve()
  assert.deepEqual(turns[1], ['question'])
})
