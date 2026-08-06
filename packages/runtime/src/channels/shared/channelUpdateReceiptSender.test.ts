import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createChannelUpdateReceiptSender,
  findChannelGroupId,
  findChannelUserId,
  type ChannelRecordDirectory
} from './channelUpdateReceiptSender.ts'

test('resolves QQ user and group ids in their separate external-id namespaces', () => {
  const directory = {
    listChannelUsers: () => [
      {
        id: 'qq-user-42',
        platform: 'qq',
        externalUserId: '42'
      }
    ],
    listChannelGroups: () => [
      {
        id: 'qq-group-42',
        platform: 'qq',
        externalGroupId: '42'
      }
    ]
  } as unknown as ChannelRecordDirectory

  assert.equal(findChannelUserId(directory, 'qq', '42'), 'qq-user-42')
  assert.equal(findChannelGroupId(directory, 'qq', '42'), 'qq-group-42')
})

test('carries the dispatch gate through async platform preparation', async () => {
  const sent: string[] = []
  let now = 100
  const sender = createChannelUpdateReceiptSender<string>({
    resolveChannelId: () => 'chan-1',
    send: async (_target, text, gate) => {
      now = 201
      gate.assertCanDispatch()
      sent.push(text)
    },
    lease: {
      claim: async () => undefined,
      ack: async () => {},
      release: async () => {}
    },
    now: () => now
  })

  await assert.rejects(
    () => sender('target', '开始更新，稍后回来。', { notAfterMs: 200 }),
    /expired before dispatch/
  )
  assert.deepEqual(sent, [])
})
