import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ChannelUserRecord,
  ChatAcceptedWithUserMessage,
  MessageDeltaEvent,
  MessageRecord,
  RunCancelledEvent,
  RunCompletedEvent,
  ThreadRecord,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { telegramPolicy } from '../shared/channelPolicy.ts'
import { createDirectMessageService, type DirectMessageServer } from './directMessageService.ts'
import { handleDmSlashCommand, shouldDiscardPendingBatchForDmCommand } from './dmSlashCommands.ts'

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
  it('adds fresh handoff thread tokens to prior DM usage', async () => {
    const channelUser = { ...createChannelUser(), usedKTokens: 64, usageLimitKTokens: 300 }
    const thread = createThread('thread-fresh', { handoffFromThreadId: 'thread-old' })
    const resolution = { thread, usageBaselineKTokens: 64 }
    const tokenUpdates: Array<{ id: string; usedKTokens: number }> = []
    const listeners = new Set<(event: YachiyoServerEvent) => void>()

    const server: DirectMessageServer = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(): Promise<ChatAcceptedWithUserMessage> {
        queueMicrotask(() => {
          const messageDelta: MessageDeltaEvent = {
            type: 'message.delta',
            eventId: 'evt-usage-1',
            timestamp: '2026-03-31T00:00:01.000Z',
            threadId: thread.id,
            runId: 'run-usage-1',
            messageId: 'msg-assistant-usage-1',
            delta: 'Fresh reply'
          }
          const runCompleted: RunCompletedEvent = {
            type: 'run.completed',
            eventId: 'evt-usage-2',
            timestamp: '2026-03-31T00:00:02.000Z',
            threadId: thread.id,
            runId: 'run-usage-1'
          }
          for (const listener of listeners) {
            listener(messageDelta)
            listener(runCompleted)
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-usage-1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens(threadId) {
        assert.equal(threadId, thread.id)
        return 2800
      },
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},
      updateChannelUser(input) {
        if (input.usedKTokens === undefined) {
          throw new Error('usedKTokens is required for this test')
        }
        tokenUpdates.push({ id: input.id, usedKTokens: input.usedKTokens })
        return { ...channelUser, usedKTokens: input.usedKTokens }
      },
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'telegram',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => resolution,
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'continue')

    await delay(20)

    assert.deepEqual(tokenUpdates, [{ id: channelUser.id, usedKTokens: 67 }])
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread: createThread('t1'), usageBaselineKTokens: 0 }),
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
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
      kind: 'image' as const,
      image: {
        dataUrl: 'data:image/png;base64,abc',
        mediaType: 'image/png' as const
      }
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

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
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: (command) => command === '/new',
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

  it('discards a pending batch for owner /workspace before the slash command runs', async () => {
    const channelUser = { ...createChannelUser(), role: 'owner' as const }
    const thread = createThread('thread-workspace-discard')
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    let batchDiscarded: boolean | undefined
    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 50,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: shouldDiscardPendingBatchForDmCommand,
      handleSlashCommand: async (_target, _channelUser, _command, _args, context) => {
        batchDiscarded = context.batchDiscarded
        return true
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')
    directMessages.enqueueMessage('chat-1', channelUser, '/workspace 1')

    await delay(100)

    assert.equal(batchDiscarded, true)
    assert.deepEqual(sentContents, [])
  })

  it('routes a number-only pending command reply before batching it as chat text', async () => {
    const channelUser = { ...createChannelUser(), role: 'owner' as const }
    const thread = createThread('thread-workspace-followup')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    const sentContents: string[] = []
    const handledCommands: Array<{ command: string; args: string; batchDiscarded: boolean }> = []

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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 50,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: (command) => command === '/workspace',
      resolvePlainTextCommand: (_channelUser, text) =>
        text.trim() === '2' ? { command: '/workspace', args: '2' } : null,
      handleSlashCommand: async (_target, _channelUser, command, args, context) => {
        handledCommands.push({ command, args, batchDiscarded: context.batchDiscarded })
        return true
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')
    directMessages.enqueueMessage('chat-1', channelUser, '2')

    await delay(100)

    assert.deepEqual(handledCommands, [{ command: '/workspace', args: '2', batchDiscarded: true }])
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

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
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: (command) => command === '/new',
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},

      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread: createThread('t1'), usageBaselineKTokens: 0 }),
      sendMessage: async (_target, text) => {
        sentMessages.push(text)
      },
      nonRunReply: 'non-run',
      errorReply: 'something went wrong',
      handleSlashCommand: async () => {
        throw new Error('backend failure')
      }
    })

    directMessages.enqueueMessage('chat-1', channelUser, '/help')

    await delay(20)

    assert.deepEqual(sentMessages, ['something went wrong'])
  })

  it('does not blank visibleReply when a run is cancelled', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-cancelled')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    const visibleReplies: string[] = []

    const server: DirectMessageServer = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(): Promise<ChatAcceptedWithUserMessage> {
        queueMicrotask(() => {
          const cancelled: RunCancelledEvent = {
            type: 'run.cancelled',
            eventId: 'evt-c1',
            timestamp: '2026-03-31T00:00:01.000Z',
            threadId: thread.id,
            runId: 'run-c1'
          }
          for (const listener of listeners) {
            listener(cancelled)
          }
        })
        return {
          kind: 'run-started',
          thread,
          runId: 'run-c1',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 500,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: (input) => {
        visibleReplies.push(input.visibleReply)
      },
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error'
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')

    await delay(50)

    assert.deepEqual(
      visibleReplies,
      [],
      'updateLatestAssistantVisibleReply must not be called on cancellation'
    )
  })

  it('aborts message handling when /stop fires before sendChat', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-abort')
    let sendChatCalled = false
    let resolveThreadGate: null | (() => void) = null

    const server: DirectMessageServer = {
      subscribe: () => () => {},
      async sendChat(): Promise<ChatAcceptedWithUserMessage> {
        sendChatCalled = true
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
      cancelRunForThread: () => false,
      cancelRunForChannelUser: () => false,
      answerToolQuestion: () => {},
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: () =>
        new Promise((resolve) => {
          resolveThreadGate = () => resolve({ thread, usageBaselineKTokens: 0 })
        }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: shouldDiscardPendingBatchForDmCommand,
      handleSlashCommand: (target, channelUser, command, args, context) =>
        handleDmSlashCommand(
          {
            server: {
              ...server,
              getConfig: async () => ({ providers: [], workspace: { savedPaths: [] } }),
              hasActiveThread: () => false,
              listOwnerDmTakeoverThreads: () => [],
              takeOverThreadForChannelUser: async () => {
                throw new Error('takeOverThreadForChannelUser should not be called')
              },
              buildThreadTakeoverContext: () => {
                throw new Error('buildThreadTakeoverContext should not be called')
              },
              buildConversationSummary: () => '',
              getThreadWorkspaceChangeBlocker: () => null,
              updateThreadWorkspace: async () => {
                throw new Error('updateThreadWorkspace should not be called')
              },
              setThreadToolMode: async () => {
                throw new Error('setThreadToolMode should not be called')
              }
            },
            threadReuseWindowMs: telegramPolicy.threadReuseWindowMs,
            contextTokenLimit: telegramPolicy.contextTokenLimit,
            createFreshThread: async () => createThread('t-fresh'),
            sendMessage: async () => {},
            requestStop: (userId) => directMessages.requestStop(userId)
          },
          target,
          channelUser,
          command,
          args,
          context
        )
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')

    await delay(10)
    assert.ok(resolveThreadGate, 'resolveThread should have been called')

    directMessages.enqueueMessage('chat-1', channelUser, '/stop')
    ;(resolveThreadGate as () => void)()
    await delay(20)

    assert.equal(sendChatCalled, false, 'sendChat must not be called after /stop aborts handling')
  })

  it('/new cancels the in-flight run via requestStop and cancelRunForChannelUser', async () => {
    const channelUser = createChannelUser()
    const thread = createThread('thread-running')
    const listeners = new Set<(event: YachiyoServerEvent) => void>()
    let cancelRunForChannelUserCalled = false

    const server: DirectMessageServer = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendChat(): Promise<ChatAcceptedWithUserMessage> {
        return {
          kind: 'run-started',
          thread,
          runId: 'run-live',
          userMessage: createUserMessage(thread.id)
        }
      },
      getThreadTotalTokens: () => 0,
      findActiveChannelThread: () => undefined,
      async setThreadModelOverride() {
        throw new Error('should not be called')
      },
      cancelRunForThread: () => true,
      cancelRunForChannelUser: (userId) => {
        if (userId === channelUser.id) cancelRunForChannelUserCalled = true
        return true
      },
      answerToolQuestion: () => {},
      updateChannelUser: (input) => ({ ...channelUser, usedKTokens: input.usedKTokens ?? 0 }),
      updateLatestAssistantVisibleReply: () => {},
      getTtlReaper: () => ({ register: () => {} })
    }

    const directMessages = createDirectMessageService({
      logLabel: 'test',
      server,
      policy: telegramPolicy,
      replyDelayMs: () => 0,
      resolveThread: async () => ({ thread, usageBaselineKTokens: 0 }),
      sendMessage: async () => {},
      nonRunReply: 'non-run',
      errorReply: 'error',
      shouldDiscardPendingBatch: shouldDiscardPendingBatchForDmCommand,
      handleSlashCommand: (target, channelUser, command, args, context) =>
        handleDmSlashCommand(
          {
            server: {
              ...server,
              getConfig: async () => ({ providers: [], workspace: { savedPaths: [] } }),
              hasActiveThread: () => false,
              listOwnerDmTakeoverThreads: () => [],
              takeOverThreadForChannelUser: async () => {
                throw new Error('takeOverThreadForChannelUser should not be called')
              },
              buildThreadTakeoverContext: () => {
                throw new Error('buildThreadTakeoverContext should not be called')
              },
              buildConversationSummary: () => '',
              getThreadWorkspaceChangeBlocker: () => null,
              updateThreadWorkspace: async () => {
                throw new Error('updateThreadWorkspace should not be called')
              },
              setThreadToolMode: async () => {
                throw new Error('setThreadToolMode should not be called')
              }
            },
            threadReuseWindowMs: telegramPolicy.threadReuseWindowMs,
            contextTokenLimit: telegramPolicy.contextTokenLimit,
            createFreshThread: async () => createThread('thread-fresh'),
            sendMessage: async () => {},
            requestStop: (userId) => directMessages.requestStop(userId)
          },
          target,
          channelUser,
          command,
          args,
          context
        )
    })

    directMessages.enqueueMessage('chat-1', channelUser, 'hello')

    await delay(30)

    directMessages.enqueueMessage('chat-1', channelUser, '/new')

    await delay(30)

    assert.equal(
      cancelRunForChannelUserCalled,
      true,
      'cancelRunForChannelUser must be called when /new cancels an in-flight run'
    )
  })
})
