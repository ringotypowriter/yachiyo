import assert from 'node:assert/strict'
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
} from '../../../shared/yachiyo/protocol.ts'
import { telegramPolicy } from './channelPolicy.ts'
import {
  createDirectMessageService,
  type DirectMessageServer,
  resolveDirectMessageThread
} from './directMessageService.ts'

function createChannelUser(): ChannelUserRecord {
  return {
    id: 'tg-user-1',
    platform: 'telegram',
    externalUserId: '123',
    username: 'alice',
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

describe('resolveDirectMessageThread', () => {
  it('reconciles the model override and compacts oversized reused threads', async () => {
    const existing = createThread('thread-existing', {
      modelOverride: { providerName: 'old', model: 'old-model' },
      source: 'telegram',
      channelUserId: 'tg-user-1'
    })
    const compacted = createThread('thread-existing', {
      modelOverride: { providerName: 'new', model: 'new-model' },
      rollingSummary: 'summary'
    })
    const modelOverride: ThreadModelOverride = { providerName: 'new', model: 'new-model' }
    const calls: string[] = []

    const server = {
      findActiveChannelThread(channelUserId: string, maxAgeMs: number): ThreadRecord | undefined {
        assert.equal(channelUserId, 'tg-user-1')
        assert.equal(maxAgeMs, telegramPolicy.threadReuseWindowMs)
        return existing
      },
      async setThreadModelOverride(input: {
        threadId: string
        modelOverride: ThreadModelOverride | null
      }): Promise<ThreadRecord> {
        calls.push(`override:${input.threadId}`)
        assert.deepEqual(input.modelOverride, modelOverride)
        return createThread(existing.id, { modelOverride })
      },
      getThreadTotalTokens(threadId: string): number {
        calls.push(`tokens:${threadId}`)
        return telegramPolicy.contextTokenLimit + 1
      },
      async compactExternalThread(input: { threadId: string }): Promise<{ thread: ThreadRecord }> {
        calls.push(`compact:${input.threadId}`)
        return { thread: compacted }
      }
    }

    const result = await resolveDirectMessageThread({
      logLabel: 'telegram',
      server,
      channelUser: createChannelUser(),
      policy: telegramPolicy,
      modelOverride,
      createThread: async () => {
        throw new Error('should not create a new thread')
      }
    })

    assert.equal(result.compacted, true)
    assert.equal(result.thread, compacted)
    assert.deepEqual(calls, [
      'override:thread-existing',
      'tokens:thread-existing',
      'compact:thread-existing'
    ])
  })
})

describe('createDirectMessageService', () => {
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
        enabledTools?: string[]
        channelHint?: string
        extraTools?: Record<string, unknown>
      }): Promise<ChatAcceptedWithUserMessage> {
        sendChatCalls++
        assert.equal(input.threadId, thread.id)
        assert.equal(input.content, 'hello\nagain')
        assert.deepEqual(input.images, undefined)
        assert.deepEqual(input.enabledTools, telegramPolicy.allowedTools)
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
      async compactExternalThread(input: { threadId: string }): Promise<{ thread: ThreadRecord }> {
        assert.fail(`compactExternalThread should not be called for ${input.threadId}`)
        throw new Error('setThreadModelOverride should not be called')
      },
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
      resolveThread: async () => ({ thread, compacted: false }),
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

  it('intercepts slash commands and skips the batch when handler returns true', async () => {
    const channelUser = createChannelUser()
    const handledCommands: Array<{ command: string; args: string }> = []
    let sendChatCalled = false

    const server: DirectMessageServer = {
      subscribe: (listener) => {
        void listener
        return () => {}
      },
      async sendChat() {
        sendChatCalled = true
        throw new Error('sendChat should not be called')
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      async compactExternalThread() {
        throw new Error('should not be called')
      },
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread: createThread('t1'), compacted: false }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      handleSlashCommand: async (_target, _user, command, args) => {
        handledCommands.push({ command, args })
        return true
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, '/new')

    await delay(20)

    assert.equal(sendChatCalled, false)
    assert.deepEqual(handledCommands, [{ command: '/new', args: '' }])
  })

  it('falls through to normal batch when slash handler returns false', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-fallthrough')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    let sendChatCalled = false

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input) {
        sendChatCalled = true
        assert.equal(input.content, '/unknown-cmd')
        queueMicrotask(() => {
          for (const l of listeners) {
            l({
              type: 'run.completed',
              eventId: 'e1',
              timestamp: '2026-03-31T00:00:00.000Z',
              threadId: thread.id,
              runId: 'r1'
            })
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'r1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      async compactExternalThread() {
        throw new Error('should not be called')
      },
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, compacted: false }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      handleSlashCommand: async () => false
    })

    directMessages.enqueueMessage('chat-1', channelUser, '/unknown-cmd')

    await delay(20)

    assert.equal(sendChatCalled, true)
  })

  it('does not intercept slash-like text that has images attached', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-images')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    let handlerCalled = false
    let sendChatCalled = false

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input) {
        sendChatCalled = true
        assert.equal(input.content, '/new')
        queueMicrotask(() => {
          for (const l of listeners) {
            l({
              type: 'run.completed',
              eventId: 'e1',
              timestamp: '2026-03-31T00:00:00.000Z',
              threadId: thread.id,
              runId: 'r1'
            })
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'r1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      async compactExternalThread() {
        throw new Error('should not be called')
      },
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, compacted: false }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      handleSlashCommand: async () => {
        handlerCalled = true
        return true
      }
    })

    // /new with an image attached — should NOT be treated as a slash command
    const fakeImage = Promise.resolve({
      dataUrl: 'data:image/png;base64,abc',
      mediaType: 'image/png' as const
    })
    directMessages.enqueueMessage('chat-1', channelUser, '/new', [fakeImage])

    await delay(20)

    assert.equal(handlerCalled, false)
    assert.equal(sendChatCalled, true)
  })

  it('discards a pending batch for /new before the slash command runs', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-discard')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    const sentContents: string[] = []

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input) {
        sentContents.push(input.content)
        queueMicrotask(() => {
          for (const l of listeners) {
            l({
              type: 'run.completed',
              eventId: 'e1',
              timestamp: '2026-03-31T00:00:00.000Z',
              threadId: thread.id,
              runId: 'r1'
            })
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'r1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      async compactExternalThread() {
        throw new Error('should not be called')
      },
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    let commandHandled = false
    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 50,
      resolveThread: async () => ({ thread, compacted: false }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: (command) => command === '/new' || command === '/compact',
      handleSlashCommand: async () => {
        commandHandled = true
        return true
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')
    directMessages.enqueueMessage('chat-1', channelUser, '/new')

    await delay(100)

    assert.equal(commandHandled, true)
    // The "hello" batch should have been discarded, not sent to AI
    assert.deepEqual(sentContents, [])
  })

  it('does not discard a pending batch for no-side-effect slash commands like /help', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-keep')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    const sentContents: string[] = []

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(input) {
        sentContents.push(input.content)
        queueMicrotask(() => {
          for (const l of listeners) {
            l({
              type: 'run.completed',
              eventId: 'e1',
              timestamp: '2026-03-31T00:00:00.000Z',
              threadId: thread.id,
              runId: 'r1'
            })
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'r1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      async compactExternalThread() {
        throw new Error('should not be called')
      },
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    let commandHandled = false
    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 50,
      resolveThread: async () => ({ thread, compacted: false }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: (command) => command === '/new' || command === '/compact',
      handleSlashCommand: async () => {
        commandHandled = true
        return true
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')
    directMessages.enqueueMessage('chat-1', channelUser, '/help')

    await delay(100)

    assert.equal(commandHandled, true)
    // The "hello" batch should still flush normally because /help does not discard
    assert.deepEqual(sentContents, ['hello'])
  })

  it('sends errorReply to the user when the slash command handler throws', async () => {
    const channelUser = createChannelUser()
    const sentMessages: string[] = []

    const server: DirectMessageServer = {
      subscribe: (listener) => {
        void listener
        return () => {}
      },
      async sendChat() {
        throw new Error('sendChat should not be called')
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      async compactExternalThread() {
        throw new Error('should not be called')
      },
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread: createThread('t1'), compacted: false }),
      sendMessage: async (_target, text) => {
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'something went wrong',
      handleSlashCommand: async () => {
        throw new Error('backend failure')
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, '/compact')

    await delay(20)

    assert.deepEqual(sentMessages, ['something went wrong'])
  })
})
