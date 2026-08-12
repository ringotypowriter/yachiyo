import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type {
  ChannelUserRecord,
  MessageImageRecord,
  SendChatAttachment,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import { qqbotPolicy } from '../../shared/channelPolicy.ts'
import type { QQBotC2CAttachment, QQBotC2CMessage, QQBotClient } from './qqbotClient.ts'
import {
  createQQBotService,
  startQQBotAttachmentDownloads,
  startQQBotImageDownloads
} from './qqbotService.ts'
import type { UpdateReceiptLease } from '../../shared/sendWithUpdateReceipt.ts'

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
      sendC2CActiveMessage: async (_openId, text) => {
        events.push(`send-active:${text}`)
      },
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

function createInboundCaptureServer(
  channelUser: ChannelUserRecord,
  capture: (input: { content: string; attachments?: SendChatAttachment[] }) => void
): YachiyoServer {
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  const thread = {
    id: 'thread-inbound-file',
    title: 'Thread',
    source: 'qqbot' as const,
    channelUserId: channelUser.id,
    workspacePath: channelUser.workspacePath,
    updatedAt: '2026-08-11T00:00:00.000Z'
  }
  return {
    listChannelUsers: () => [channelUser],
    createChannelUser: () => channelUser,
    subscribe(listener: (event: YachiyoServerEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async sendChat(input) {
      capture({ content: input.content, attachments: input.attachments })
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            type: 'run.completed',
            eventId: 'event-inbound-file-completed',
            timestamp: '2026-08-11T00:00:01.000Z',
            threadId: thread.id,
            runId: 'run-inbound-file'
          })
        }
      })
      return {
        kind: 'run-started',
        thread,
        runId: 'run-inbound-file',
        userMessage: {
          id: 'user-message-inbound-file',
          threadId: thread.id,
          role: 'user',
          content: input.content,
          attachments: [],
          status: 'completed',
          createdAt: '2026-08-11T00:00:00.000Z'
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

describe('startQQBotAttachmentDownloads', () => {
  it('accepts an unnamed file from its supported MIME type', async () => {
    const downloads = startQQBotAttachmentDownloads(
      [
        {
          contentType: 'application/pdf',
          url: 'https://multimedia.nt.qq.com/download?fileid=file-1'
        }
      ],
      {
        includeFiles: true,
        policy: { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 }
      },
      undefined,
      async (_url, options) => ({
        dataUrl: 'data:application/pdf;base64,AAA',
        mediaType: options.mediaType ?? '',
        filename: options.filename,
        attachmentIndex: options.attachmentIndex
      })
    )

    assert.deepEqual(await Promise.all(downloads), [
      {
        kind: 'file',
        attachment: {
          dataUrl: 'data:application/pdf;base64,AAA',
          mediaType: 'application/pdf',
          filename: 'qqbot-file-1',
          attachmentIndex: 1
        }
      }
    ])
  })

  it('marks files unavailable without downloading them when file access is disabled', async () => {
    let downloadCalls = 0
    const downloads = startQQBotAttachmentDownloads(
      [
        {
          contentType: 'application/zip',
          filename: 'skill.zip',
          url: 'https://multimedia.nt.qq.com/download?fileid=file-1'
        }
      ],
      {
        includeFiles: false,
        policy: { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 }
      },
      undefined,
      async () => {
        downloadCalls += 1
        return null
      }
    )

    assert.deepEqual(await Promise.all(downloads), [
      {
        kind: 'unavailable',
        filename: 'skill.zip',
        attachmentIndex: 1,
        reason: 'not-permitted'
      }
    ])
    assert.equal(downloadCalls, 0)
  })

  it('recognizes an image filename when QQ omits content_type', async () => {
    const calls: string[] = []
    const downloads = startQQBotAttachmentDownloads(
      [
        {
          contentType: '',
          filename: 'photo.png',
          url: 'https://multimedia.nt.qq.com/download?fileid=image-1'
        }
      ],
      {
        includeFiles: true,
        policy: { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 }
      },
      async (_url, options) => {
        assert.ok(options)
        calls.push('image')
        return {
          dataUrl: 'data:image/png;base64,AAA',
          mediaType: 'image/png',
          filename: options.filename,
          attachmentIndex: options.attachmentIndex
        }
      },
      async () => {
        calls.push('file')
        return null
      }
    )

    assert.deepEqual(await Promise.all(downloads), [
      {
        kind: 'image',
        image: {
          dataUrl: 'data:image/png;base64,AAA',
          mediaType: 'image/png',
          filename: 'photo.png',
          attachmentIndex: 1
        }
      }
    ])
    assert.deepEqual(calls, ['image'])
  })

  it('recognizes a BMP filename when QQ omits content_type', async () => {
    const calls: string[] = []
    const downloads = startQQBotAttachmentDownloads(
      [
        {
          contentType: '',
          filename: 'diagram.bmp',
          url: 'https://multimedia.nt.qq.com/download?fileid=image-1'
        }
      ],
      {
        includeFiles: true,
        policy: { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 }
      },
      async (_url, options) => {
        assert.ok(options)
        calls.push('image')
        return {
          dataUrl: 'data:image/png;base64,AAA',
          mediaType: 'image/png',
          filename: options.filename,
          attachmentIndex: options.attachmentIndex
        }
      },
      async () => {
        calls.push('file')
        return null
      }
    )

    assert.deepEqual(await Promise.all(downloads), [
      {
        kind: 'image',
        image: {
          dataUrl: 'data:image/png;base64,AAA',
          mediaType: 'image/png',
          filename: 'diagram.bmp',
          attachmentIndex: 1
        }
      }
    ])
    assert.deepEqual(calls, ['image'])
  })

  it('applies the batch cap independently to files and images', async () => {
    const calls: string[] = []
    const downloads = startQQBotAttachmentDownloads(
      [
        {
          contentType: 'application/pdf',
          filename: 'first.pdf',
          url: 'https://multimedia.nt.qq.com/download?fileid=file-1'
        },
        {
          contentType: 'image/png',
          filename: 'first.png',
          url: 'https://multimedia.nt.qq.com/download?fileid=image-1'
        },
        {
          contentType: 'application/pdf',
          filename: 'ignored.pdf',
          url: 'https://multimedia.nt.qq.com/download?fileid=file-2'
        },
        {
          contentType: 'image/png',
          filename: 'ignored.png',
          url: 'https://multimedia.nt.qq.com/download?fileid=image-2'
        }
      ],
      {
        includeFiles: true,
        policy: { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 }
      },
      async (_url, options) => {
        assert.ok(options)
        calls.push(`image:${options.attachmentIndex}`)
        return {
          dataUrl: 'data:image/png;base64,AAA',
          mediaType: 'image/png',
          filename: options.filename,
          attachmentIndex: options.attachmentIndex
        }
      },
      async (_url, options) => {
        calls.push(`file:${options.attachmentIndex}`)
        return {
          dataUrl: 'data:application/pdf;base64,AAA',
          mediaType: 'application/pdf',
          filename: options.filename,
          attachmentIndex: options.attachmentIndex
        }
      }
    )

    const attachments = (await Promise.all(downloads)).filter((attachment) => attachment !== null)

    assert.deepEqual(calls, ['file:1', 'image:2'])
    assert.deepEqual(attachments, [
      {
        kind: 'file',
        attachment: {
          dataUrl: 'data:application/pdf;base64,AAA',
          mediaType: 'application/pdf',
          filename: 'first.pdf',
          attachmentIndex: 1
        }
      },
      {
        kind: 'image',
        image: {
          dataUrl: 'data:image/png;base64,AAA',
          mediaType: 'image/png',
          filename: 'first.png',
          attachmentIndex: 2
        }
      },
      {
        kind: 'unavailable',
        filename: 'ignored.pdf',
        attachmentIndex: 3,
        reason: 'batch-limit'
      },
      {
        kind: 'unavailable',
        filename: 'ignored.png',
        attachmentIndex: 4,
        reason: 'batch-limit'
      }
    ])
  })
})

it('forwards QQBot C2C zip attachments with or without accompanying text', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () =>
    new Response(Buffer.from('PK\u0003\u0004skill'), {
      status: 200,
      headers: {
        'content-length': '9',
        'content-type': 'application/zip'
      }
    })

  const events: string[] = []
  const captured: Array<{ content: string; attachments?: SendChatAttachment[] }> = []
  const channelUser = createChannelUser({ status: 'allowed', role: 'owner' })
  const { client, receive } = createClient(events)
  const service = createQQBotService({
    appId: 'app-1',
    clientSecret: 'secret-1',
    server: createInboundCaptureServer(channelUser, (input) => captured.push(input)),
    updateReceiptLease: createLease(events),
    client,
    replyDelayMs: () => 0
  })
  t.after(() => service.stop())

  receive({
    openId: channelUser.externalUserId,
    content: '安装这个 skills',
    messageId: 'inbound-zip',
    timestamp: '2026-08-11T00:00:00.000Z',
    attachments: [
      {
        contentType: 'application/zip',
        filename: 'prompt-engineering-foundations.zip',
        size: 9,
        url: '//multimedia.nt.qq.com/download?fileid=skill-zip'
      }
    ]
  })

  await waitFor(() => captured.length === 1)

  assert.equal(captured[0].content, '安装这个 skills')
  assert.deepEqual(captured[0].attachments, [
    {
      filename: 'prompt-engineering-foundations.zip',
      mediaType: 'application/zip',
      dataUrl: 'data:application/zip;base64,UEsDBHNraWxs',
      attachmentIndex: 1
    }
  ])

  receive({
    openId: channelUser.externalUserId,
    content: '',
    messageId: 'inbound-file-only',
    timestamp: '2026-08-11T00:00:01.000Z',
    attachments: [
      {
        contentType: 'application/zip',
        filename: 'file-only.zip',
        size: 9,
        url: '//multimedia.nt.qq.com/download?fileid=file-only-zip'
      }
    ]
  })

  await waitFor(() => captured.length === 2)
  assert.equal(captured[1].content, '')
  assert.deepEqual(captured[1].attachments, [
    {
      filename: 'file-only.zip',
      mediaType: 'application/zip',
      dataUrl: 'data:application/zip;base64,UEsDBHNraWxs',
      attachmentIndex: 1
    }
  ])

  receive({
    openId: channelUser.externalUserId,
    content: '看看这个文件',
    messageId: 'inbound-unsupported-file',
    timestamp: '2026-08-11T00:00:02.000Z',
    attachments: [
      {
        contentType: 'application/vnd.rar',
        filename: 'unsupported.rar',
        size: 9,
        url: '//multimedia.nt.qq.com/download?fileid=unsupported-file'
      }
    ]
  })

  await waitFor(() => captured.length === 3)
  assert.equal(
    captured[2].content,
    '看看这个文件\n\n[Attachment 1 unavailable: unsupported.rar (unsupported type)]'
  )
  assert.equal(captured[2].attachments, undefined)
})

it('does not download files beyond the cap across rapid QQBot messages', async (t) => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(Buffer.from('pdf'), {
      status: 200,
      headers: {
        'content-length': '3',
        'content-type': 'application/pdf'
      }
    })
  }

  const events: string[] = []
  const captured: Array<{ content: string; attachments?: SendChatAttachment[] }> = []
  const channelUser = createChannelUser({ status: 'allowed', role: 'owner' })
  const { client, receive } = createClient(events)
  const service = createQQBotService({
    appId: 'app-1',
    clientSecret: 'secret-1',
    server: createInboundCaptureServer(channelUser, (input) => captured.push(input)),
    updateReceiptLease: createLease(events),
    client,
    policy: { ...qqbotPolicy, maxImagesPerBatch: 2 },
    replyDelayMs: () => 10
  })
  t.after(() => service.stop())

  const file = (index: number): QQBotC2CAttachment => ({
    contentType: 'application/pdf',
    filename: `report-${index}.pdf`,
    size: 3,
    url: `https://multimedia.nt.qq.com/download?fileid=${index}`
  })
  receive({
    openId: channelUser.externalUserId,
    content: 'first pair',
    messageId: 'inbound-first-pair',
    timestamp: '2026-08-11T00:00:00.000Z',
    attachments: [file(1), file(2)]
  })
  receive({
    openId: channelUser.externalUserId,
    content: 'second pair',
    messageId: 'inbound-second-pair',
    timestamp: '2026-08-11T00:00:01.000Z',
    attachments: [file(3), file(4)]
  })

  await waitFor(() => captured.length === 1)

  assert.equal(fetchCalls, 2)
  assert.deepEqual(
    captured[0]?.attachments?.map(({ filename, attachmentIndex }) => ({
      filename,
      attachmentIndex
    })),
    [
      { filename: 'report-1.pdf', attachmentIndex: 1 },
      { filename: 'report-2.pdf', attachmentIndex: 2 }
    ]
  )
  assert.equal(
    captured[0]?.content,
    'first pair\nsecond pair\n\n' +
      '[Attachment 3 unavailable: report-3.pdf (batch limit)]\n\n' +
      '[Attachment 4 unavailable: report-4.pdf (batch limit)]'
  )
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

it('does not start expired QQBot reply or active API sends', async () => {
  const events: string[] = []
  const channelUser = createChannelUser()
  const { client, receive } = createClient(events)
  const service = createQQBotService({
    appId: 'app-1',
    clientSecret: 'secret-1',
    server: createServer(channelUser),
    updateReceiptLease: createLease(events),
    client
  })
  receive({
    openId: channelUser.externalUserId,
    content: 'remember this reply target',
    messageId: 'inbound-1',
    timestamp: '2026-08-05T00:00:00.000Z'
  })

  await assert.rejects(
    () => service.sendMessage(channelUser.externalUserId, 'announce', { notAfterMs: 0 }),
    /expired before dispatch/
  )
  await assert.rejects(
    () => service.sendActiveMessage(channelUser.externalUserId, 'announce', { notAfterMs: 0 }),
    /expired before dispatch/
  )
  assert.deepEqual(events, ['claim:qqbot-open-1', 'release:claim-1'])
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
