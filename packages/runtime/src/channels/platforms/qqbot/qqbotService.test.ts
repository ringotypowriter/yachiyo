import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type {
  ChannelUserRecord,
  MessageImageRecord,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import type { QQBotC2CMessage, QQBotClient } from './qqbotClient.ts'
import { createQQBotService, startQQBotImageDownloads } from './qqbotService.ts'
import type { UpdateReceiptLease } from './sendWithUpdateReceipt.ts'

function createChannelUser(overrides: Partial<ChannelUserRecord> = {}): ChannelUserRecord {
  return {
    id: 'qqbot-open-1',
    platform: 'qqbot',
    externalUserId: 'open-1',
    username: 'open-1',
    label: '',
    status: 'blocked',
    role: 'guest',
    usageLimitKTokens: null,
    usedKTokens: 0,
    workspacePath: '/tmp/qqbot-open-1',
    ...overrides
  }
}

function createServer(channelUser: ChannelUserRecord): YachiyoServer {
  return {
    listChannelUsers: () => [channelUser],
    createChannelUser: () => channelUser
  } as unknown as YachiyoServer
}

function createClient(events: string[]): {
  client: QQBotClient
  receive(message: QQBotC2CMessage): void
} {
  let receiveMessage: ((message: QQBotC2CMessage) => void) | undefined
  return {
    client: {
      connect: () => {},
      close: async () => {},
      healthCheck: async () => true,
      onC2CMessage: (handler) => {
        receiveMessage = handler
      },
      sendC2CMessage: async (_openId, text, replyMsgId) => {
        events.push(`send:${text}:${replyMsgId}`)
      },
      sendC2CActiveMessage: async () => {},
      sendC2CImage: async (_openId, _path, replyMsgId) => {
        events.push(`image:${replyMsgId}`)
      },
      sendC2CFile: async () => {},
      sendTypingIndicator: async () => {}
    },
    receive(message) {
      assert.ok(receiveMessage, 'service must subscribe to the supplied QQ client')
      receiveMessage(message)
    }
  }
}

function createLease(events: string[]): UpdateReceiptLease {
  return {
    claim: async (channelId) => {
      events.push(`claim:${channelId}`)
      return { claimToken: 'claim-1', message: 'receipt' }
    },
    ack: async (claimToken) => {
      events.push(`ack:${claimToken}`)
    },
    release: async (claimToken) => {
      events.push(`release:${claimToken}`)
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createAttachmentReplyServer(
  channelUser: ChannelUserRecord,
  attachmentPath: string
): YachiyoServer {
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  const thread = {
    id: 'thread-attachment',
    title: 'Thread',
    source: 'qqbot' as const,
    channelUserId: channelUser.id,
    updatedAt: '2026-08-05T00:00:00.000Z'
  }
  return {
    listChannelUsers: () => [channelUser],
    createChannelUser: () => channelUser,
    subscribe(listener: (event: YachiyoServerEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async sendChat(input) {
      const replyTool = input.extraTools?.reply as {
        execute(input: {
          attachments: Array<{ path: string; filename: string; mediaType: string }>
        }): Promise<string>
      }
      await replyTool.execute({
        attachments: [{ path: attachmentPath, filename: 'chart.png', mediaType: 'image/png' }]
      })
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            type: 'run.completed',
            eventId: 'event-attachment-completed',
            timestamp: '2026-08-05T00:00:01.000Z',
            threadId: thread.id,
            runId: 'run-attachment'
          })
        }
      })
      return {
        kind: 'run-started',
        thread,
        runId: 'run-attachment',
        userMessage: {
          id: 'user-message-attachment',
          threadId: thread.id,
          role: 'user',
          content: 'send the chart',
          status: 'completed',
          createdAt: '2026-08-05T00:00:00.000Z'
        }
      }
    },
    createThread: async () => thread,
    findActiveChannelThread: () => undefined,
    setThreadModelOverride: async () => {
      throw new Error('owner QQBot DMs must not apply the guest model override')
    },
    getThreadTotalTokens: () => 0,
    updateLatestAssistantVisibleReply: () => {},
    updateChannelUser: () => channelUser,
    getTtlReaper: () => ({ register: () => {} }),
    cancelRunForThread: () => false,
    cancelRunForChannelUser: () => false,
    answerToolQuestion: () => {}
  } as unknown as YachiyoServer
}

describe('startQQBotImageDownloads', () => {
  it('downloads filtered images with contiguous indices from protocol-relative QQ URLs', async () => {
    const image: MessageImageRecord = {
      dataUrl: 'data:image/png;base64,AAA',
      mediaType: 'image/png',
      filename: 'photo.png',
      attachmentIndex: 1
    }
    const calls: Array<{ url: string; options: unknown }> = []

    const downloads = startQQBotImageDownloads(
      [
        {
          contentType: 'application/pdf',
          filename: 'notes.pdf',
          url: '//multimedia.nt.qq.com/download?fileid=file-1'
        },
        {
          contentType: 'image/png',
          filename: 'photo.png',
          url: '//multimedia.nt.qq.com/download?fileid=image-1'
        },
        {
          contentType: 'image/jpeg',
          filename: 'ignored.jpg',
          url: 'https://multimedia.nt.qq.com/download?fileid=image-2'
        }
      ],
      { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 },
      async (url, options) => {
        calls.push({ url, options })
        return image
      }
    )

    assert.deepEqual(await Promise.all(downloads), [{ kind: 'image', image }])
    assert.deepEqual(calls, [
      {
        url: 'https://multimedia.nt.qq.com/download?fileid=image-1',
        options: {
          maxBytes: 5 * 1024 * 1024,
          attachmentIndex: 1,
          filename: 'photo.png'
        }
      }
    ])
  })
})

it('manual sends carry and acknowledge an owed update receipt', async () => {
  const events: string[] = []
  const channelUser = createChannelUser()
  const { client, receive } = createClient(events)
  const options = {
    appId: 'app-1',
    clientSecret: 'secret-1',
    server: createServer(channelUser),
    updateReceiptLease: createLease(events),
    client
  }
  const service = createQQBotService(options)
  receive({
    openId: channelUser.externalUserId,
    content: 'remember this reply target',
    messageId: 'inbound-1',
    timestamp: '2026-08-05T00:00:00.000Z'
  })

  await service.sendMessage(channelUser.externalUserId, 'manual message')

  assert.deepEqual(events, [
    'claim:qqbot-open-1',
    'send:receipt\n\nmanual message:inbound-1',
    'ack:claim-1'
  ])
})

it('quota replies carry and acknowledge an owed update receipt', async () => {
  const events: string[] = []
  const channelUser = createChannelUser({
    status: 'allowed',
    usageLimitKTokens: 1,
    usedKTokens: 1
  })
  const { client, receive } = createClient(events)
  createQQBotService({
    appId: 'app-1',
    clientSecret: 'secret-1',
    server: createServer(channelUser),
    updateReceiptLease: createLease(events),
    client
  })

  receive({
    openId: channelUser.externalUserId,
    content: 'over quota',
    messageId: 'quota-inbound',
    timestamp: '2026-08-05T00:00:00.000Z'
  })
  await waitFor(() => events.includes('ack:claim-1'))

  assert.equal(events[0], 'claim:qqbot-open-1')
  assert.match(events[1], /^send:receipt\n\n.+:quota-inbound$/s)
  assert.equal(events[2], 'ack:claim-1')
})

it('attachment-only replies send the owed receipt before the attachment', async (t) => {
  const attachmentDir = await mkdtemp(join(homedir(), '.yachiyo-qqbot-receipt-'))
  t.after(async () => rm(attachmentDir, { recursive: true, force: true }))
  const attachmentPath = join(attachmentDir, 'chart.png')
  await writeFile(attachmentPath, 'chart')

  const events: string[] = []
  const channelUser = createChannelUser({ status: 'allowed', role: 'owner' })
  const { client, receive } = createClient(events)
  const service = createQQBotService({
    appId: 'app-1',
    clientSecret: 'secret-1',
    server: createAttachmentReplyServer(channelUser, attachmentPath),
    updateReceiptLease: createLease(events),
    client,
    replyDelayMs: () => 0
  })
  t.after(() => service.stop())

  receive({
    openId: channelUser.externalUserId,
    content: 'send the chart',
    messageId: 'attachment-inbound',
    timestamp: '2026-08-05T00:00:00.000Z'
  })
  await waitFor(() => events.includes('image:attachment-inbound'), 10_000)

  assert.deepEqual(events, [
    'claim:qqbot-open-1',
    'send:receipt:attachment-inbound',
    'ack:claim-1',
    'image:attachment-inbound'
  ])
})
