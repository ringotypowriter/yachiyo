import assert from 'node:assert/strict'
import test from 'node:test'
import { Telegram } from 'telegraf'

import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import type { UpdateReceiptLease } from '../../shared/sendWithUpdateReceipt.ts'
import { createTelegramService } from './telegramService.ts'
import { splitTelegramMessage } from './telegramMessageSplit.ts'

test('splitTelegramMessage keeps every chunk inside the Telegram text limit', () => {
  const text = [
    'Took over:',
    '🛠️ Long context',
    '',
    '---',
    '',
    'Last recap:',
    'a'.repeat(2500),
    '',
    '---',
    '',
    'Since then:',
    'b'.repeat(2500)
  ].join('\n')

  const chunks = splitTelegramMessage(text)

  assert.equal(chunks.length, 2)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 4096))
})

test('carries a deferred update receipt on the next Telegram outbound', async (t) => {
  const events: string[] = []
  t.mock.method(Telegram.prototype, 'sendMessage', async (_chatId, text) => {
    events.push(`send:${text}`)
    return {} as never
  })

  const lease: UpdateReceiptLease = {
    async claim(channelId) {
      events.push(`claim:${channelId}`)
      return { claimToken: 'claim-1', message: 'update receipt' }
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
        id: 'telegram-user-1',
        platform: 'telegram',
        externalUserId: '123'
      }
    ],
    listChannelGroups: () => []
  } as unknown as YachiyoServer

  const service = createTelegramService({
    botToken: 'token',
    server,
    updateReceiptLease: lease
  })

  await service.sendMessage('123', 'ordinary reply')

  assert.deepEqual(events, [
    'claim:telegram-user-1',
    'send:update receipt\n\nordinary reply',
    'ack:claim-1'
  ])
})

test('does not start an expired Telegram API send', async (t) => {
  const events: string[] = []
  t.mock.method(Telegram.prototype, 'sendMessage', async () => {
    events.push('send')
    return {} as never
  })
  const server = {
    listChannelUsers: () => [
      { id: 'telegram-user-1', platform: 'telegram', externalUserId: '123' }
    ],
    listChannelGroups: () => []
  } as unknown as YachiyoServer
  const service = createTelegramService({
    botToken: 'token',
    server,
    updateReceiptLease: {
      claim: async () => {
        events.push('claim')
        return { claimToken: 'claim-1', message: 'receipt' }
      },
      ack: async () => {
        events.push('ack')
      },
      release: async () => {
        events.push('release')
      }
    }
  })

  await assert.rejects(
    () => service.sendMessage('123', '开始更新，稍后回来。', { notAfterMs: 0 }),
    /expired before dispatch/
  )
  assert.deepEqual(events, ['claim', 'release'])
})
