import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  ChannelUserRecord,
  ThreadModelOverride,
  ThreadRecord
} from '../../../shared/yachiyo/protocol.ts'
import { handleDmSlashCommand, type DmSlashCommandOptions } from './dmSlashCommands.ts'

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

function makeOptions<TTarget>(
  overrides: Partial<DmSlashCommandOptions<TTarget>> & {
    sendMessage: DmSlashCommandOptions<TTarget>['sendMessage']
  }
): DmSlashCommandOptions<TTarget> {
  return {
    server: {
      findActiveChannelThread: () => undefined,
      getThreadTotalTokens: () => 0,
      cancelRunForChannelUser: () => false
    },
    threadReuseWindowMs: 3_600_000,
    contextTokenLimit: 100_000,
    createFreshThread: async () => {
      throw new Error('createFreshThread should not be called')
    },
    ...overrides
  }
}

describe('handleDmSlashCommand', () => {
  describe('/new', () => {
    it('creates a fresh thread, cancels any old run, and sends a confirmation', async () => {
      const fresh = createThread('thread-new')
      const channelUser = createChannelUser()
      let threadCreated = false
      let cancelledUserId: string | undefined
      const callOrder: string[] = []
      const sent: string[] = []

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: () => undefined,
          getThreadTotalTokens: () => 0,
          cancelRunForChannelUser: (userId) => {
            callOrder.push('cancel')
            cancelledUserId = userId
            return true
          }
        },
        createFreshThread: async (u) => {
          assert.equal(u.id, channelUser.id)
          callOrder.push('create')
          threadCreated = true
          return fresh
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/new', '')

      assert.equal(handled, true)
      assert.equal(threadCreated, true)
      assert.equal(cancelledUserId, channelUser.id)
      assert.deepEqual(callOrder, ['create', 'cancel'], 'cancel must happen after create succeeds')
      assert.equal(sent.length, 1)
      assert.ok(sent[0].includes('New conversation started.'))
    })

    it('includes a discard notice when batchDiscarded is true', async () => {
      const fresh = createThread('thread-new')
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        createFreshThread: async () => fresh,
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/new', '', {
        batchDiscarded: true
      })

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.ok(
        sent[0].includes('Your unsent message was discarded.'),
        `reply should include discard notice, got: ${sent[0]}`
      )
      assert.ok(
        sent[0].includes('New conversation started.'),
        `reply should include confirmation, got: ${sent[0]}`
      )
    })
  })

  describe('/status', () => {
    it('reports model and token usage for an active thread with model override', async () => {
      const modelOverride: ThreadModelOverride = {
        providerName: 'anthropic',
        model: 'claude-opus-4-6'
      }
      const thread = createThread('thread-1', { modelOverride })
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: (userId, maxAgeMs) => {
            assert.equal(userId, channelUser.id)
            assert.equal(maxAgeMs, 3_600_000)
            return thread
          },
          getThreadTotalTokens: (threadId) => {
            assert.equal(threadId, thread.id)
            return 18_000
          },
          cancelRunForChannelUser: () => false
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/status', '')

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.ok(
        sent[0].includes('claude-opus-4-6'),
        `reply should include model name, got: ${sent[0]}`
      )
      assert.ok(sent[0].includes('18k'), `reply should include token count, got: ${sent[0]}`)
      assert.ok(sent[0].includes('100k'), `reply should include token limit, got: ${sent[0]}`)
    })

    it('uses "default" as model label when thread has no model override', async () => {
      const thread = createThread('thread-1')
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: () => thread,
          getThreadTotalTokens: () => 5_000,
          cancelRunForChannelUser: () => false
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/status', '')

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.ok(sent[0].includes('default'), `reply should say "default", got: ${sent[0]}`)
    })

    it('reports no active conversation when no thread exists', async () => {
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: () => undefined,
          getThreadTotalTokens: () => 0,
          cancelRunForChannelUser: () => false
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/status', '')

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.ok(
        sent[0].toLowerCase().includes('no active') ||
          sent[0].toLowerCase().includes('no conversation'),
        `reply should indicate no active conversation, got: ${sent[0]}`
      )
    })
  })

  describe('/stop', () => {
    it('cancels the active run for the channel user', async () => {
      const channelUser = createChannelUser()
      const sent: string[] = []
      let cancelledUserId: string | undefined

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: () => undefined,
          getThreadTotalTokens: () => 0,
          cancelRunForChannelUser: (userId) => {
            cancelledUserId = userId
            return true
          }
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/stop', '')

      assert.equal(handled, true)
      assert.equal(cancelledUserId, channelUser.id)
      assert.equal(sent.length, 1)
      assert.ok(sent[0].includes('Run stopped'), `reply should confirm stop, got: ${sent[0]}`)
    })

    it('reports no active run when nothing is running', async () => {
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/stop', '')

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.ok(
        sent[0].includes('No active run'),
        `reply should say no active run, got: ${sent[0]}`
      )
    })

    it('includes a discard notice when batchDiscarded is true', async () => {
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: () => undefined,
          getThreadTotalTokens: () => 0,
          cancelRunForChannelUser: () => true
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/stop', '', {
        batchDiscarded: true
      })

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.ok(
        sent[0].includes('Your unsent message was discarded.'),
        `reply should include discard notice, got: ${sent[0]}`
      )
      assert.ok(sent[0].includes('Run stopped'), `reply should confirm stop, got: ${sent[0]}`)
    })
  })

  it('replies with an error for unknown commands and does not fall through', async () => {
    const channelUser = createChannelUser()
    const sent: string[] = []

    const options = makeOptions<string>({
      sendMessage: async (_target, text) => {
        sent.push(text)
      }
    })

    const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/unknown', '')

    assert.equal(handled, true)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].includes('/unknown'), `reply should mention the bad command, got: ${sent[0]}`)
    assert.ok(
      sent[0].toLowerCase().includes('unknown') || sent[0].toLowerCase().includes('/help'),
      `reply should hint at /help, got: ${sent[0]}`
    )
  })

  describe('/help', () => {
    it('sends a list of all available commands', async () => {
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/help', '')

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      for (const cmd of ['/new', '/status', '/stop', '/help']) {
        assert.ok(sent[0].includes(cmd), `reply should mention ${cmd}, got: ${sent[0]}`)
      }
    })
  })
})
