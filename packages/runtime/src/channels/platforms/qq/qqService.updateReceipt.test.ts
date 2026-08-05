import assert from 'node:assert/strict'
import test from 'node:test'

import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import type { UpdateReceiptLease } from '../../shared/sendWithUpdateReceipt.ts'
import type { OneBotClient } from './onebotClient.ts'
import { createQQService } from './qqService.ts'

function createClient(events: string[]): OneBotClient {
  return {
    connect: () => undefined,
    close: async () => undefined,
    healthCheck: async () => true,
    onConnect: (handler) => void handler,
    onPrivateMessage: (handler) => void handler,
    onGroupMessage: (handler) => void handler,
    sendPrivateMessage: async (userId, text) => {
      events.push(`send-user:${userId}:${text}`)
      return { messageId: 1 }
    },
    sendGroupMessage: async (groupId, text) => {
      events.push(`send-group:${groupId}:${text}`)
      return { messageId: 2 }
    },
    sendPrivateImage: async () => ({ messageId: 3 }),
    uploadPrivateFile: async () => undefined,
    getLoginInfo: async () => ({ userId: 999, nickname: 'bot' }),
    getImage: async () => {
      throw new Error('not used')
    },
    getMsg: async () => {
      throw new Error('not used')
    },
    setInputStatus: async () => undefined
  }
}

function createServer(): YachiyoServer {
  return {
    listChannelUsers: () => [{ id: 'qq-user-42', platform: 'qq', externalUserId: '42' }],
    listChannelGroups: () => [{ id: 'qq-group-42', platform: 'qq', externalGroupId: '42' }]
  } as unknown as YachiyoServer
}

function createLease(events: string[]): UpdateReceiptLease {
  return {
    claim: async (channelId) => {
      events.push(`claim:${channelId}`)
      return { claimToken: channelId, message: `receipt:${channelId}` }
    },
    ack: async (claimToken) => {
      events.push(`ack:${claimToken}`)
    },
    release: async (claimToken) => {
      events.push(`release:${claimToken}`)
    }
  }
}

test('carries a deferred receipt through QQ user and group outbounds', async () => {
  const events: string[] = []
  const service = createQQService({
    wsUrl: 'ws://unused.example',
    server: createServer(),
    updateReceiptLease: createLease(events),
    client: createClient(events)
  })

  await service.sendPrivateMessage(42, 'private reply')
  await service.sendGroupMessage(42, 'group reply')

  assert.deepEqual(events, [
    'claim:qq-user-42',
    'send-user:42:receipt:qq-user-42\n\nprivate reply',
    'ack:qq-user-42',
    'claim:qq-group-42',
    'send-group:42:receipt:qq-group-42\n\ngroup reply',
    'ack:qq-group-42'
  ])
})

test('does not start expired QQ user or group API sends', async () => {
  const events: string[] = []
  const service = createQQService({
    wsUrl: 'ws://unused.example',
    server: createServer(),
    client: createClient(events),
    updateReceiptLease: createLease(events)
  })

  await assert.rejects(
    () => service.sendPrivateMessage(42, 'announce', { notAfterMs: 0 }),
    /expired before dispatch/
  )
  await assert.rejects(
    () => service.sendGroupMessage(42, 'announce', { notAfterMs: 0 }),
    /expired before dispatch/
  )
  assert.deepEqual(events, [
    'claim:qq-user-42',
    'release:qq-user-42',
    'claim:qq-group-42',
    'release:qq-group-42'
  ])
})
