import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ChannelUserRecord,
  ChatAcceptedWithUserMessage,
  MessageDeltaEvent,
  MessageRecord,
  RunCompletedEvent,
  ThreadModelOverride,
  ThreadRecord,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { telegramPolicy } from '../shared/channelPolicy.ts'
import {
  collectDirectMessageRunOutput,
  createDirectMessageService,
  resolveDirectMessageThread,
  type DirectMessageServer
} from './directMessageService.ts'

function createChannelUser(): ChannelUserRecord {
  return {
    id: 'tg-user-1',
    platform: 'telegram',
    externalUserId: '123',
    username: 'alice',
    label: '',
    status: 'allowed',
    role: 'guest',
    usageLimitKTokens: null,
    usedKTokens: 0,
    workspacePath: '/tmp/tg-alice'
  }
}

function createThread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    title: 'Thread',
    updatedAt: '2026-03-31T00:00:00.000Z',
    ...overrides
  }
}

function createUserMessage(threadId: string): MessageRecord {
  return {
    id: 'msg-1',
    threadId,
    role: 'user',
    content: 'hello',
    status: 'completed',
    createdAt: '2026-03-31T00:00:00.000Z'
  }
}

describe('directMessageService', () => {
  describe('resolveDirectMessageThread', () => {
    it('does not apply the channel model to a fresh owner DM thread', async () => {
      const fresh = createThread('thread-owner-fresh', {
        source: 'telegram',
        channelUserId: 'tg-user-1'
      })
      const createCalls: Array<
        { handoffFromThreadId?: string; workspacePath?: string } | undefined
      > = []

      const result = await resolveDirectMessageThread({
        logLabel: 'telegram',
        server: {
          findActiveChannelThread() {
            return undefined
          },
          getThreadTotalTokens() {
            assert.fail('getThreadTotalTokens should not be called for a fresh thread')
          },
          async setThreadModelOverride() {
            throw new Error('setThreadModelOverride should not be called for owner DMs')
          }
        },
        channelUser: { ...createChannelUser(), role: 'owner' },
        policy: telegramPolicy,
        modelOverride: { providerName: 'channel', model: 'guest-model' },
        createThread: async (input) => {
          createCalls.push(input)
          return fresh
        }
      })

      assert.equal(result.thread, fresh)
      assert.equal(result.usageBaselineKTokens, 0)
      assert.deepEqual(createCalls, [undefined])
    })

    it('preserves an existing owner DM thread model override when a channel model is configured', async () => {
      const threadOverride: ThreadModelOverride = { providerName: 'work', model: 'gpt-5' }
      const existing = createThread('thread-owner-existing', {
        source: 'telegram',
        channelUserId: 'tg-user-1',
        modelOverride: threadOverride
      })

      const result = await resolveDirectMessageThread({
        logLabel: 'telegram',
        server: {
          findActiveChannelThread(channelUserId, maxAgeMs) {
            assert.equal(channelUserId, 'tg-user-1')
            assert.equal(maxAgeMs, telegramPolicy.threadReuseWindowMs)
            return existing
          },
          getThreadTotalTokens(threadId) {
            assert.equal(threadId, existing.id)
            return 12_000
          },
          async setThreadModelOverride() {
            throw new Error('setThreadModelOverride should not be called for owner DMs')
          }
        },
        channelUser: { ...createChannelUser(), role: 'owner' },
        policy: telegramPolicy,
        modelOverride: { providerName: 'channel', model: 'guest-model' },
        createThread: async () => {
          throw new Error('createThread should not be called when an active thread exists')
        }
      })

      assert.equal(result.thread, existing)
      assert.deepEqual(result.thread.modelOverride, threadOverride)
      assert.equal(result.usageBaselineKTokens, 0)
    })

    it('carries an owner DM thread model override into a token-limit handoff thread', async () => {
      const threadOverride: ThreadModelOverride = { providerName: 'work', model: 'gpt-5' }
      const existing = createThread('thread-owner-existing', {
        source: 'telegram',
        channelUserId: 'tg-user-1',
        modelOverride: threadOverride,
        workspacePath: '/work/yachiyo'
      })
      const fresh = createThread('thread-owner-fresh', {
        source: 'telegram',
        channelUserId: 'tg-user-1',
        handoffFromThreadId: existing.id,
        workspacePath: existing.workspacePath
      })
      const updated = createThread(fresh.id, {
        ...fresh,
        modelOverride: threadOverride
      })
      const createCalls: Array<
        { handoffFromThreadId?: string; workspacePath?: string } | undefined
      > = []
      const overrideCalls: Array<{ threadId: string; modelOverride: ThreadModelOverride | null }> =
        []

      const result = await resolveDirectMessageThread({
        logLabel: 'telegram',
        server: {
          findActiveChannelThread() {
            return existing
          },
          getThreadTotalTokens(threadId) {
            assert.equal(threadId, existing.id)
            return telegramPolicy.contextTokenLimit
          },
          async setThreadModelOverride(input) {
            overrideCalls.push(input)
            assert.equal(input.threadId, fresh.id)
            return updated
          }
        },
        channelUser: { ...createChannelUser(), role: 'owner', usedKTokens: 4 },
        policy: telegramPolicy,
        modelOverride: { providerName: 'channel', model: 'guest-model' },
        createThread: async (input) => {
          createCalls.push(input)
          return fresh
        }
      })

      assert.equal(result.thread, updated)
      assert.deepEqual(result.thread.modelOverride, threadOverride)
      assert.deepEqual(createCalls, [
        { handoffFromThreadId: existing.id, workspacePath: '/work/yachiyo' }
      ])
      assert.deepEqual(overrideCalls, [{ threadId: fresh.id, modelOverride: threadOverride }])
      assert.equal(result.usageBaselineKTokens, 64)
    })

    it('applies the channel model to an existing guest DM thread', async () => {
      const channelOverride: ThreadModelOverride = { providerName: 'channel', model: 'guest-model' }
      const existing = createThread('thread-guest-existing', {
        source: 'telegram',
        channelUserId: 'tg-user-1',
        modelOverride: { providerName: 'old', model: 'old-model' }
      })
      const updated = createThread(existing.id, {
        ...existing,
        modelOverride: channelOverride
      })
      const overrideCalls: Array<{ threadId: string; modelOverride: ThreadModelOverride | null }> =
        []

      const result = await resolveDirectMessageThread({
        logLabel: 'telegram',
        server: {
          findActiveChannelThread() {
            return existing
          },
          getThreadTotalTokens(threadId) {
            assert.equal(threadId, existing.id)
            return 3_000
          },
          async setThreadModelOverride(input) {
            overrideCalls.push(input)
            return updated
          }
        },
        channelUser: createChannelUser(),
        policy: telegramPolicy,
        modelOverride: channelOverride,
        createThread: async () => {
          throw new Error('createThread should not be called when an active thread exists')
        }
      })

      assert.equal(result.thread, updated)
      assert.deepEqual(overrideCalls, [{ threadId: existing.id, modelOverride: channelOverride }])
    })

    it('creates a fresh handoff thread when the active DM reaches the token threshold', async () => {
      const existing = createThread('thread-existing', {
        source: 'telegram',
        channelUserId: 'tg-user-1',
        workspacePath: '/work/yachiyo'
      })
      const fresh = createThread('thread-fresh', {
        source: 'telegram',
        channelUserId: 'tg-user-1',
        handoffFromThreadId: existing.id
      })
      const createCalls: Array<
        { handoffFromThreadId?: string; workspacePath?: string } | undefined
      > = []

      const result = await resolveDirectMessageThread({
        logLabel: 'telegram',
        server: {
          findActiveChannelThread(channelUserId, maxAgeMs) {
            assert.equal(channelUserId, 'tg-user-1')
            assert.equal(maxAgeMs, telegramPolicy.threadReuseWindowMs)
            return existing
          },
          getThreadTotalTokens(threadId) {
            assert.equal(threadId, existing.id)
            return telegramPolicy.contextTokenLimit
          },
          async setThreadModelOverride() {
            throw new Error('setThreadModelOverride should not be called')
          }
        },
        channelUser: { ...createChannelUser(), usedKTokens: 128 },
        policy: telegramPolicy,
        createThread: async (input) => {
          createCalls.push(input)
          return fresh
        }
      })

      assert.equal(result.thread, fresh)
      assert.equal(result.usageBaselineKTokens, 128)
      assert.deepEqual(createCalls, [
        { handoffFromThreadId: existing.id, workspacePath: '/work/yachiyo' }
      ])
    })
  })

  describe('collectDirectMessageRunOutput', () => {
    it('collects normal output only from the bound run id', async () => {
      const listeners = new Set<(event: YachiyoServerEvent) => void>()
      const server = {
        subscribe(listener: (event: YachiyoServerEvent) => void): () => void {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }

      const collection = collectDirectMessageRunOutput(server, 'thread-1')
      const emit = (event: YachiyoServerEvent): void => {
        for (const listener of listeners) listener(event)
      }

      emit({
        type: 'message.delta',
        eventId: 'other-delta',
        timestamp: '2026-03-31T00:00:00.000Z',
        threadId: 'thread-1',
        runId: 'run-other',
        messageId: 'msg-other',
        delta: 'Wrong'
      })
      emit({
        type: 'run.completed',
        eventId: 'other-completed',
        timestamp: '2026-03-31T00:00:01.000Z',
        threadId: 'thread-1',
        runId: 'run-other'
      })
      emit({
        type: 'message.delta',
        eventId: 'target-delta',
        timestamp: '2026-03-31T00:00:02.000Z',
        threadId: 'thread-1',
        runId: 'run-target',
        messageId: 'msg-target',
        delta: 'Right'
      })
      emit({
        type: 'run.completed',
        eventId: 'target-completed',
        timestamp: '2026-03-31T00:00:03.000Z',
        threadId: 'thread-1',
        runId: 'run-target'
      })

      collection.bindRun('run-target')

      assert.equal(await collection.promise, 'Right')
      assert.equal(listeners.size, 0)
    })
  })

  it('batches rapid messages and runs the shared fallback reply flow once', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-1')
    const sentMessages: string[] = []
    const visibleReplies: string[] = []
    const tokenUpdates: Array<{ id: string; usedKTokens: number }> = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    let sendChatCalls = 0

    const server: DirectMessageServer = {
      subscribe(listener: (event: YachiyoServerEvent) => void): () => void {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input: {
        threadId: string
        content: string
        images?: { dataUrl: string; mediaType: string; filename?: string; workspacePath?: string }[]
        toolPreset?: string[]
        runTrigger?: string
        channelHint?: string
        extraTools?: Record<string, unknown>
      }): Promise<ChatAcceptedWithUserMessage> {
        sendChatCalls++
        assert.equal(input.threadId, thread.id)
        assert.equal(input.content, 'hello\nagain')
        assert.deepEqual(input.images, undefined)
        assert.deepEqual(input.toolPreset, telegramPolicy.allowedTools)
        assert.equal(input.runTrigger, 'channel')
        assert.equal(input.channelHint, telegramPolicy.replyInstruction)
        queueMicrotask(() => {
          const messageDelta: MessageDeltaEvent = {
            type: 'message.delta',
            eventId: 'evt-1',
            timestamp: '2026-03-31T00:00:01.000Z',
            threadId: thread.id,
            runId: 'run-1',
            messageId: 'msg-assistant-1',
            delta: 'Shared reply'
          }
          const runCompleted: RunCompletedEvent = {
            type: 'run.completed',
            eventId: 'evt-2',
            timestamp: '2026-03-31T00:00:02.000Z',
            threadId: thread.id,
            runId: 'run-1'
          }
          for (const listener of listeners) {
            listener(messageDelta)
            listener(runCompleted)
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens(threadId: string): number {
        assert.equal(threadId, thread.id)
        return 1100
      },
      findActiveChannelThread(channelUserId: string, maxAgeMs: number): ThreadRecord | undefined {
        assert.equal(channelUserId, channelUser.id)
        assert.equal(maxAgeMs, telegramPolicy.threadReuseWindowMs)
        return undefined
      },
      async setThreadModelOverride(input: {
        threadId: string
        modelOverride: ThreadModelOverride | null
      }): Promise<ThreadRecord> {
        assert.fail(`setThreadModelOverride should not be called for ${input.threadId}`)
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,

      updateChannelUser(input: { id: string; usedKTokens: number }): ChannelUserRecord {
        tokenUpdates.push(input)
        return { ...channelUser, usedKTokens: input.usedKTokens }
      },
      updateLatestAssistantVisibleReply(input: { threadId: string; visibleReply: string }): void {
        assert.equal(input.threadId, thread.id)
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper(): { register: (path: string, ttlMs: number) => void } {
        return {
          register(path: string, ttlMs: number): void {
            assert.equal(typeof path, 'string')
            assert.equal(typeof ttlMs, 'number')
          }
        }
      }
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId: string, text: string) => {
        sentMessages.push(text)
      },
      startBatchIndicator: () => undefined,
      startHandlingIndicator: () => undefined,
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')
    directMessages.enqueueMessage('chat-1', channelUser, 'again')

    await delay(20)

    assert.equal(sendChatCalls, 1)
    assert.deepEqual(sentMessages, ['Shared reply'])
    assert.deepEqual(visibleReplies, ['Shared reply'])
    assert.deepEqual(tokenUpdates, [{ id: channelUser.id, usedKTokens: 2 }])
  })

  it('stores live reply tool messages and final output as the outbound transcript', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-live-reply')
    const sentMessages: string[] = []
    const visibleReplies: string[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input): Promise<ChatAcceptedWithUserMessage> {
        const replyTool = input.extraTools?.reply as {
          execute(input: { message: string }): Promise<string>
        }
        await replyTool.execute({ message: 'Working on it' })
        queueMicrotask(() => {
          const messageDelta: MessageDeltaEvent = {
            type: 'message.delta',
            eventId: 'evt-live-final',
            timestamp: '2026-03-31T00:00:01.000Z',
            threadId: thread.id,
            runId: 'run-live-reply',
            messageId: 'msg-assistant-live',
            delta: 'Final answer'
          }
          const runCompleted: RunCompletedEvent = {
            type: 'run.completed',
            eventId: 'evt-live-completed',
            timestamp: '2026-03-31T00:00:02.000Z',
            threadId: thread.id,
            runId: 'run-live-reply'
          }
          for (const listener of listeners) {
            listener(messageDelta)
            listener(runCompleted)
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-live-reply',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply(input) {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')

    await delay(20)

    assert.deepEqual(sentMessages, ['Working on it', 'Final answer'])
    assert.deepEqual(visibleReplies, ['Working on it\nFinal answer'])
  })

  it('allows owner DM reply tool calls to send file attachments under home', async (t) => {
    const attachmentDir = await mkdtemp(join(homedir(), '.yachiyo-dm-attachment-'))
    t.after(async () => {
      await rm(attachmentDir, { recursive: true, force: true })
    })
    const filePath = join(attachmentDir, 'report.txt')
    await writeFile(filePath, 'report')
    const resolvedFilePath = await realpath(filePath)

    const channelUser = { ...createChannelUser(), role: 'owner' as const }
    const thread = createThread('thread-owner-file-reply')
    const sentMessages: string[] = []
    const sentReplies: Array<{
      target: string
      message?: string
      attachments: Array<{ path: string; filename?: string; mediaType?: string }>
    }> = []
    let copiedAttachmentPath = ''
    let copiedAttachmentContent = ''
    const visibleReplies: string[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input): Promise<ChatAcceptedWithUserMessage> {
        const replyTool = input.extraTools?.reply as {
          execute(input: {
            message?: string
            attachments?: Array<{ path: string; filename?: string; mediaType?: string }>
          }): Promise<string>
        }
        await replyTool.execute({
          message: 'Here is the file',
          attachments: [{ path: filePath, filename: 'final-report.txt', mediaType: 'text/plain' }]
        })
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              type: 'run.completed',
              eventId: 'evt-owner-file-completed',
              timestamp: '2026-03-31T00:00:02.000Z',
              threadId: thread.id,
              runId: 'run-owner-file-reply'
            })
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-owner-file-reply',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply(input) {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService<string>({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      sendReply: async (target, payload) => {
        const attachment = payload.attachments?.[0]
        assert.ok(attachment)
        copiedAttachmentPath = attachment.path
        await writeFile(filePath, 'mutated')
        copiedAttachmentContent = await readFile(attachment.path, 'utf8')
        sentReplies.push({
          target,
          message: payload.message,
          attachments: payload.attachments ?? []
        })
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'send the report')

    await delay(20)

    assert.deepEqual(sentMessages, [])
    assert.equal(sentReplies.length, 1)
    assert.equal(sentReplies[0].target, 'chat-1')
    assert.equal(sentReplies[0].message, 'Here is the file')
    assert.equal(sentReplies[0].attachments.length, 1)
    assert.notEqual(sentReplies[0].attachments[0].path, resolvedFilePath)
    assert.match(sentReplies[0].attachments[0].path, /\.yachiyo\/channel-reply-attachments\//)
    assert.equal(sentReplies[0].attachments[0].filename, 'final-report.txt')
    assert.equal(sentReplies[0].attachments[0].mediaType, 'text/plain')
    assert.equal(copiedAttachmentContent, 'report')
    await assert.rejects(readFile(copiedAttachmentPath), { code: 'ENOENT' })
    assert.deepEqual(visibleReplies, ['Here is the file\n[Attachment: final-report.txt]'])
  })

  it('rejects owner DM reply attachments whose real path leaves home', async (t) => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'yachiyo-dm-outside-attachment-'))
    const homeDir = await mkdtemp(join(homedir(), '.yachiyo-dm-symlink-attachment-'))
    t.after(async () => {
      await rm(outsideDir, { recursive: true, force: true })
      await rm(homeDir, { recursive: true, force: true })
    })
    const outsideFilePath = join(outsideDir, 'secret.txt')
    const symlinkPath = join(homeDir, 'secret-link.txt')
    await writeFile(outsideFilePath, 'secret')
    await symlink(outsideFilePath, symlinkPath)

    const channelUser = { ...createChannelUser(), role: 'owner' as const }
    const thread = createThread('thread-owner-file-reply-outside-home')
    const sentMessages: string[] = []
    const sentReplies: unknown[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input): Promise<ChatAcceptedWithUserMessage> {
        const replyTool = input.extraTools?.reply as {
          execute(input: {
            message?: string
            attachments?: Array<{ path: string; filename?: string; mediaType?: string }>
          }): Promise<string>
        }
        await replyTool.execute({
          message: 'Here is the file',
          attachments: [{ path: symlinkPath, filename: 'secret.txt', mediaType: 'text/plain' }]
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-owner-file-reply-outside-home',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      sendReply: async (_target, payload) => {
        sentReplies.push(payload)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'send the symlink')

    await delay(20)

    assert.deepEqual(sentReplies, [])
    assert.deepEqual(sentMessages, ['error'])
  })

  it('does not let guest DM reply tool calls send file attachments', async () => {
    const attachmentDir = await mkdtemp(join(tmpdir(), 'yachiyo-dm-guest-attachment-'))
    const filePath = join(attachmentDir, 'secret.txt')
    await writeFile(filePath, 'secret')

    const channelUser = createChannelUser()
    const thread = createThread('thread-guest-file-reply')
    const sentMessages: string[] = []
    const sentReplies: unknown[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input): Promise<ChatAcceptedWithUserMessage> {
        const replyTool = input.extraTools?.reply as {
          execute(input: {
            message?: string
            attachments?: Array<{ path: string; filename?: string; mediaType?: string }>
          }): Promise<string>
        }
        const result = await replyTool.execute({
          message: 'Text only',
          attachments: [{ path: filePath, filename: 'secret.txt', mediaType: 'text/plain' }]
        })
        assert.equal(result, 'File attachments are not available in this channel. Message sent.')
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              type: 'run.completed',
              eventId: 'evt-guest-file-completed',
              timestamp: '2026-03-31T00:00:02.000Z',
              threadId: thread.id,
              runId: 'run-guest-file-reply'
            })
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-guest-file-reply',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      sendReply: async (_target, payload) => {
        sentReplies.push(payload)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'try sending a file')

    await delay(20)

    assert.deepEqual(sentMessages, ['Text only'])
    assert.deepEqual(sentReplies, [])
  })

  it('flushes normal output before tool calls so IM history preserves sequence', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-sequence')
    const sentMessages: string[] = []
    const visibleReplies: string[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(): Promise<ChatAcceptedWithUserMessage> {
        setTimeout(() => {
          for (const listener of listeners) {
            listener({
              type: 'message.delta',
              eventId: 'evt-sequence-text-1',
              timestamp: '2026-03-31T00:00:01.000Z',
              threadId: thread.id,
              runId: 'run-sequence',
              messageId: 'msg-assistant-sequence',
              delta: 'I will check first. '
            })
            listener({
              type: 'tool.updated',
              eventId: 'evt-sequence-tool',
              timestamp: '2026-03-31T00:00:02.000Z',
              threadId: thread.id,
              runId: 'run-sequence',
              toolCall: {
                id: 'tool-sequence',
                runId: 'run-sequence',
                threadId: thread.id,
                toolName: 'read',
                status: 'running',
                inputSummary: 'Read a file',
                startedAt: '2026-03-31T00:00:02.000Z'
              }
            })
            listener({
              type: 'message.delta',
              eventId: 'evt-sequence-text-2',
              timestamp: '2026-03-31T00:00:03.000Z',
              threadId: thread.id,
              runId: 'run-sequence',
              messageId: 'msg-assistant-sequence',
              delta: 'Then I found the answer.'
            })
            listener({
              type: 'run.completed',
              eventId: 'evt-sequence-completed',
              timestamp: '2026-03-31T00:00:04.000Z',
              threadId: thread.id,
              runId: 'run-sequence'
            })
          }
        }, 0)
        return {
          kind: 'run-started',
          thread,
          runId: 'run-sequence',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply(input) {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'please check')

    await delay(20)

    assert.deepEqual(sentMessages, ['I will check first.', 'Then I found the answer.'])
    assert.deepEqual(visibleReplies, ['I will check first.\nThen I found the answer.'])
  })

  it('preserves repeated normal output segments around separate tool calls', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-repeated-segments')
    const sentMessages: string[] = []
    const visibleReplies: string[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(): Promise<ChatAcceptedWithUserMessage> {
        setTimeout(() => {
          for (const listener of listeners) {
            listener({
              type: 'message.delta',
              eventId: 'evt-repeat-text-1',
              timestamp: '2026-03-31T00:00:01.000Z',
              threadId: thread.id,
              runId: 'run-repeated-segments',
              messageId: 'msg-assistant-repeat',
              delta: 'Same step. '
            })
            listener({
              type: 'tool.updated',
              eventId: 'evt-repeat-tool-1',
              timestamp: '2026-03-31T00:00:02.000Z',
              threadId: thread.id,
              runId: 'run-repeated-segments',
              toolCall: {
                id: 'tool-repeat-1',
                runId: 'run-repeated-segments',
                threadId: thread.id,
                toolName: 'read',
                status: 'running',
                inputSummary: 'Read first file',
                startedAt: '2026-03-31T00:00:02.000Z'
              }
            })
            listener({
              type: 'message.delta',
              eventId: 'evt-repeat-text-2',
              timestamp: '2026-03-31T00:00:03.000Z',
              threadId: thread.id,
              runId: 'run-repeated-segments',
              messageId: 'msg-assistant-repeat',
              delta: 'Same step. '
            })
            listener({
              type: 'tool.updated',
              eventId: 'evt-repeat-tool-2',
              timestamp: '2026-03-31T00:00:04.000Z',
              threadId: thread.id,
              runId: 'run-repeated-segments',
              toolCall: {
                id: 'tool-repeat-2',
                runId: 'run-repeated-segments',
                threadId: thread.id,
                toolName: 'read',
                status: 'running',
                inputSummary: 'Read second file',
                startedAt: '2026-03-31T00:00:04.000Z'
              }
            })
            listener({
              type: 'run.completed',
              eventId: 'evt-repeat-completed',
              timestamp: '2026-03-31T00:00:05.000Z',
              threadId: thread.id,
              runId: 'run-repeated-segments'
            })
          }
        }, 0)
        return {
          kind: 'run-started',
          thread,
          runId: 'run-repeated-segments',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply(input) {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'repeat the same status')

    await delay(20)

    assert.deepEqual(sentMessages, ['Same step.', 'Same step.'])
    assert.deepEqual(visibleReplies, ['Same step.\nSame step.'])
  })

  it('serializes reply tool messages after queued normal output segments', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-serialized-reply')
    const sentMessages: string[] = []
    const visibleReplies: string[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input): Promise<ChatAcceptedWithUserMessage> {
        const replyTool = input.extraTools?.reply as {
          execute(input: { message: string }): Promise<string>
        }
        setTimeout(() => {
          void (async () => {
            for (const listener of listeners) {
              listener({
                type: 'message.delta',
                eventId: 'evt-serialize-text',
                timestamp: '2026-03-31T00:00:01.000Z',
                threadId: thread.id,
                runId: 'run-serialized-reply',
                messageId: 'msg-assistant-serialized',
                delta: 'Normal first.'
              })
              listener({
                type: 'tool.updated',
                eventId: 'evt-serialize-tool',
                timestamp: '2026-03-31T00:00:02.000Z',
                threadId: thread.id,
                runId: 'run-serialized-reply',
                toolCall: {
                  id: 'tool-serialized',
                  runId: 'run-serialized-reply',
                  threadId: thread.id,
                  toolName: 'read',
                  status: 'running',
                  inputSummary: 'Read a file',
                  startedAt: '2026-03-31T00:00:02.000Z'
                }
              })
            }
            await replyTool.execute({ message: 'Live second.' })
            for (const listener of listeners) {
              listener({
                type: 'run.completed',
                eventId: 'evt-serialize-completed',
                timestamp: '2026-03-31T00:00:03.000Z',
                threadId: thread.id,
                runId: 'run-serialized-reply'
              })
            }
          })()
        }, 0)
        return {
          kind: 'run-started',
          thread,
          runId: 'run-serialized-reply',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply(input) {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        if (text === 'Normal first.') {
          await delay(30)
        }
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'serialize please')

    await delay(80)

    assert.deepEqual(sentMessages, ['Normal first.', 'Live second.'])
    assert.deepEqual(visibleReplies, ['Normal first.\nLive second.'])
  })

  it('dedupes reply tool messages already sent as normal output', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-dedupe-reply-after-text')
    const sentMessages: string[] = []
    const visibleReplies: string[] = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input): Promise<ChatAcceptedWithUserMessage> {
        const replyTool = input.extraTools?.reply as {
          execute(input: { message: string }): Promise<string>
        }
        setTimeout(() => {
          void (async () => {
            for (const listener of listeners) {
              listener({
                type: 'message.delta',
                eventId: 'evt-dedupe-reply-text',
                timestamp: '2026-03-31T00:00:01.000Z',
                threadId: thread.id,
                runId: 'run-dedupe-reply-after-text',
                messageId: 'msg-assistant-dedupe-reply',
                delta: 'Same outbound.'
              })
              listener({
                type: 'tool.updated',
                eventId: 'evt-dedupe-reply-tool',
                timestamp: '2026-03-31T00:00:02.000Z',
                threadId: thread.id,
                runId: 'run-dedupe-reply-after-text',
                toolCall: {
                  id: 'tool-dedupe-reply',
                  runId: 'run-dedupe-reply-after-text',
                  threadId: thread.id,
                  toolName: 'read',
                  status: 'running',
                  inputSummary: 'Read a file',
                  startedAt: '2026-03-31T00:00:02.000Z'
                }
              })
            }
            await replyTool.execute({ message: 'Same outbound.' })
            for (const listener of listeners) {
              listener({
                type: 'run.completed',
                eventId: 'evt-dedupe-reply-completed',
                timestamp: '2026-03-31T00:00:03.000Z',
                threadId: thread.id,
                runId: 'run-dedupe-reply-after-text'
              })
            }
          })()
        }, 0)
        return {
          kind: 'run-started',
          thread,
          runId: 'run-dedupe-reply-after-text',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply(input) {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'avoid duplicate')

    await delay(80)

    assert.deepEqual(sentMessages, ['Same outbound.'])
    assert.deepEqual(visibleReplies, ['Same outbound.'])
  })
})
