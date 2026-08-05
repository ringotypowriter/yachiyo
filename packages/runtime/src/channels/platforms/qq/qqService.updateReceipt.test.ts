import assert from 'node:assert/strict'
import test from 'node:test'

import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import type { UpdateReceiptLease } from '../../shared/sendWithUpdateReceipt.ts'
import type { OneBotClient } from './onebotClient.ts'
import { createQQService } from './qqService.ts'

test('carries a deferred receipt through QQ user and group outbounds', async () => {
  const events: string[] = []
  const client = {
    connect() {
      return undefined
    },
    async close() {
      return undefined
    },
    async healthCheck() {
      return true
    },
    onConnect(handler) {
      void handler
    },
    onPrivateMessage(handler) {
      void handler
    },
    onGroupMessage(handler) {
      void handler
    },
    async sendPrivateMessage(userId: number, text: string) {
      events.push(`send-user:${userId}:${text}`)
      return { messageId: 1 }
    },
    async sendGroupMessage(groupId: number, text: string) {
      events.push(`send-group:${groupId}:${text}`)
      return { messageId: 2 }
    },
    async sendPrivateImage() {
      return { messageId: 3 }
    },
    async uploadPrivateFile() {
      return undefined
    },
    async getLoginInfo() {
      return { userId: 999, nickname: 'bot' }
    },
    async getImage() {
      throw new Error('not used')
    },
    async getMsg() {
      throw new Error('not used')
    },
    async setInputStatus() {
      return undefined
    }
  } satisfies OneBotClient
  const lease: UpdateReceiptLease = {
    async claim(channelId) {
      events.push(`claim:${channelId}`)
      return { claimToken: channelId, message: `receipt:${channelId}` }
    },
    async ack(claimToken) {
      events.push(`ack:${claimToken}`)
    },
    async release(claimToken) {
      events.push(`release:${claimToken}`)
    }
  }
  const server = {
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
  } as unknown as YachiyoServer

  const service = createQQService({
    wsUrl: 'ws://unused.example',
    server,
    updateReceiptLease: lease,
    client
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
