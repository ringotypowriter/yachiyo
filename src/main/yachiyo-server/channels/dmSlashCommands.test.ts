import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  ChannelUserRecord,
  SettingsConfig,
  ThreadModelOverride,
  ThreadRecord
} from '../../../shared/yachiyo/protocol.ts'
import {
  handleDmSlashCommand,
  shouldDiscardPendingBatchForDmCommand,
  type DmSlashCommandOptions
} from './dmSlashCommands.ts'

function createChannelUser(overrides: Partial<ChannelUserRecord> = {}): ChannelUserRecord {
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
    workspacePath: '/tmp/tg-alice',
    ...overrides
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

function createConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
  return {
    providers: [],
    workspace: {
      savedPaths: ['/work/yachiyo', '/work/research-notes'],
      pathLabels: {
        '/work/yachiyo': 'Yachiyo',
        '/work/research-notes': 'Research Notes'
      }
    },
    ...overrides
  }
}

function makeOptions<TTarget>(
  overrides: Omit<Partial<DmSlashCommandOptions<TTarget>>, 'server'> & {
    server?: Partial<DmSlashCommandOptions<TTarget>['server']>
    sendMessage: DmSlashCommandOptions<TTarget>['sendMessage']
  }
): DmSlashCommandOptions<TTarget> {
  const defaultServer: DmSlashCommandOptions<TTarget>['server'] = {
    findActiveChannelThread: () => undefined,
    getThreadTotalTokens: () => 0,
    hasActiveThread: () => false,
    cancelRunForChannelUser: () => false,
    getConfig: async () => createConfig(),
    getThreadWorkspaceChangeBlocker: () => null,
    updateThreadWorkspace: async () => {
      throw new Error('updateThreadWorkspace should not be called')
    }
  }
  const { server, ...rest } = overrides
  return {
    server: { ...defaultServer, ...(server ?? {}) },
    threadReuseWindowMs: 3_600_000,
    contextTokenLimit: 100_000,
    createFreshThread: async () => {
      throw new Error('createFreshThread should not be called')
    },
    ...rest
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
    it('reports detailed status for an active owner thread', async () => {
      const modelOverride: ThreadModelOverride = {
        providerName: 'anthropic',
        model: 'claude-opus-4-6'
      }
      const thread = createThread('thread-1', {
        title: 'Launch Review',
        modelOverride,
        workspacePath: '/work/yachiyo'
      })
      const channelUser = createChannelUser({
        role: 'owner',
        usedKTokens: 42,
        usageLimitKTokens: 120
      })
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
          hasActiveThread: (threadId) => {
            assert.equal(threadId, thread.id)
            return true
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
      assert.match(sent[0], /Conversation: Launch Review/)
      assert.match(sent[0], /State: running/)
      assert.match(sent[0], /Channel: telegram · owner/)
      assert.match(sent[0], /Model: anthropic \/ claude-opus-4-6/)
      assert.match(sent[0], /Context: 18k \/ 100k \(18%, 82k remaining\)/)
      assert.match(sent[0], /Usage: 42k \/ 120k/)
      assert.match(sent[0], /Workspace: Yachiyo/)
      assert.match(sent[0], /\/work\/yachiyo/)
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

    it('does not expose workspace details to guest users', async () => {
      const thread = createThread('thread-1', { workspacePath: '/tmp/tg-alice' })
      const channelUser = createChannelUser()
      const sent: string[] = []

      const options = makeOptions<string>({
        server: {
          findActiveChannelThread: () => thread,
          getThreadTotalTokens: () => 5_000
        },
        sendMessage: async (_target, text) => {
          sent.push(text)
        }
      })

      const handled = await handleDmSlashCommand(options, 'chat-1', channelUser, '/status', '')

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].includes('Workspace:'), false)
      assert.equal(sent[0].includes('/tmp/tg-alice'), false)
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

    it('includes /workspace for owner users only', async () => {
      const owner = createChannelUser({ role: 'owner' })
      const guest = createChannelUser()
      const ownerReplies: string[] = []
      const guestReplies: string[] = []

      await handleDmSlashCommand(
        makeOptions<string>({
          sendMessage: async (_target, text) => {
            ownerReplies.push(text)
          }
        }),
        'chat-1',
        owner,
        '/help',
        ''
      )
      await handleDmSlashCommand(
        makeOptions<string>({
          sendMessage: async (_target, text) => {
            guestReplies.push(text)
          }
        }),
        'chat-1',
        guest,
        '/help',
        ''
      )

      assert.equal(ownerReplies.length, 1)
      assert.equal(guestReplies.length, 1)
      assert.ok(ownerReplies[0].includes('/workspace'))
      assert.equal(guestReplies[0].includes('/workspace'), false)
    })
  })

  describe('/workspace', () => {
    it('lists saved workspaces by index for owner users', async () => {
      const channelUser = createChannelUser({ role: 'owner' })
      const sent: string[] = []

      const handled = await handleDmSlashCommand(
        makeOptions<string>({
          sendMessage: async (_target, text) => {
            sent.push(text)
          }
        }),
        'chat-1',
        channelUser,
        '/workspace',
        ''
      )

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.match(sent[0], /1\. Yachiyo/)
      assert.match(sent[0], /\/work\/yachiyo/)
      assert.match(sent[0], /2\. Research Notes/)
      assert.match(sent[0], /\/work\/research-notes/)
      assert.match(sent[0], /\/workspace 1/)
    })

    it('switches the active owner thread to the selected workspace index', async () => {
      const channelUser = createChannelUser({ role: 'owner' })
      const activeThread = createThread('thread-active')
      const sent: string[] = []
      const workspaceUpdates: Array<{ threadId: string; workspacePath?: string | null }> = []

      const handled = await handleDmSlashCommand(
        makeOptions<string>({
          server: {
            findActiveChannelThread: () => activeThread,
            getThreadTotalTokens: () => 0,
            cancelRunForChannelUser: () => false,
            getConfig: async () => createConfig(),
            updateThreadWorkspace: async (input) => {
              workspaceUpdates.push(input)
              return createThread(input.threadId, {
                workspacePath: input.workspacePath ?? undefined
              })
            }
          },
          sendMessage: async (_target, text) => {
            sent.push(text)
          }
        }),
        'chat-1',
        channelUser,
        '/workspace',
        '2'
      )

      assert.equal(handled, true)
      assert.deepEqual(workspaceUpdates, [
        { threadId: activeThread.id, workspacePath: '/work/research-notes' }
      ])
      assert.equal(sent.length, 1)
      assert.match(sent[0], /Research Notes/)
      assert.match(sent[0], /\/work\/research-notes/)
    })

    it('returns the workspace lock message before showing choices', async () => {
      const channelUser = createChannelUser({ role: 'owner' })
      const activeThread = createThread('thread-active')
      const sent: string[] = []
      let configRead = false

      const handled = await handleDmSlashCommand(
        makeOptions<string>({
          server: {
            findActiveChannelThread: () => activeThread,
            getConfig: async () => {
              configRead = true
              return createConfig()
            },
            getThreadWorkspaceChangeBlocker: () =>
              'Workspace can only be changed before the first message is sent.'
          },
          sendMessage: async (_target, text) => {
            sent.push(text)
          }
        }),
        'chat-1',
        channelUser,
        '/workspace',
        ''
      )

      assert.equal(handled, true)
      assert.equal(configRead, false)
      assert.deepEqual(sent, ['Workspace can only be changed before the first message is sent.'])
    })

    it('includes a discard notice when batchDiscarded is true', async () => {
      const channelUser = createChannelUser({ role: 'owner' })
      const activeThread = createThread('thread-active')
      const sent: string[] = []

      const handled = await handleDmSlashCommand(
        makeOptions<string>({
          server: {
            findActiveChannelThread: () => activeThread,
            updateThreadWorkspace: async (input) =>
              createThread(input.threadId, { workspacePath: input.workspacePath ?? undefined })
          },
          sendMessage: async (_target, text) => {
            sent.push(text)
          }
        }),
        'chat-1',
        channelUser,
        '/workspace',
        '1',
        { batchDiscarded: true }
      )

      assert.equal(handled, true)
      assert.equal(sent.length, 1)
      assert.match(sent[0], /Your unsent message was discarded\./)
      assert.match(sent[0], /Workspace switched to Yachiyo\./)
    })

    it('creates a fresh owner thread before switching when no active thread exists', async () => {
      const channelUser = createChannelUser({ role: 'owner' })
      const freshThread = createThread('thread-fresh')
      const workspaceUpdates: Array<{ threadId: string; workspacePath?: string | null }> = []
      let createdForUserId: string | undefined

      const handled = await handleDmSlashCommand(
        makeOptions<string>({
          server: {
            findActiveChannelThread: () => undefined,
            getThreadTotalTokens: () => 0,
            cancelRunForChannelUser: () => false,
            getConfig: async () => createConfig(),
            updateThreadWorkspace: async (input) => {
              workspaceUpdates.push(input)
              return createThread(input.threadId, {
                workspacePath: input.workspacePath ?? undefined
              })
            }
          },
          createFreshThread: async (user) => {
            createdForUserId = user.id
            return freshThread
          },
          sendMessage: async () => {}
        }),
        'chat-1',
        channelUser,
        '/workspace',
        '1'
      )

      assert.equal(handled, true)
      assert.equal(createdForUserId, channelUser.id)
      assert.deepEqual(workspaceUpdates, [
        { threadId: freshThread.id, workspacePath: '/work/yachiyo' }
      ])
    })

    it('hides the workspace command from guest users', async () => {
      const channelUser = createChannelUser()
      const sent: string[] = []
      let configRead = false

      const handled = await handleDmSlashCommand(
        makeOptions<string>({
          server: {
            findActiveChannelThread: () => undefined,
            getThreadTotalTokens: () => 0,
            cancelRunForChannelUser: () => false,
            getConfig: async () => {
              configRead = true
              return createConfig()
            },
            updateThreadWorkspace: async () => {
              throw new Error('updateThreadWorkspace should not be called')
            }
          },
          sendMessage: async (_target, text) => {
            sent.push(text)
          }
        }),
        'chat-1',
        channelUser,
        '/workspace',
        ''
      )

      assert.equal(handled, true)
      assert.equal(configRead, false)
      assert.equal(sent.length, 1)
      assert.match(sent[0], /Unknown command: \/workspace/)
    })

    it('discards pending batches for owner workspace commands only', () => {
      assert.equal(
        shouldDiscardPendingBatchForDmCommand('/workspace', createChannelUser({ role: 'owner' })),
        true
      )
      assert.equal(shouldDiscardPendingBatchForDmCommand('/workspace', createChannelUser()), false)
    })
  })
})
