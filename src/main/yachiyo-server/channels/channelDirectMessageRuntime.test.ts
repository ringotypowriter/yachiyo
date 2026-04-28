import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ChannelUserRecord, ThreadRecord } from '../../../shared/yachiyo/protocol.ts'
import { telegramPolicy } from './channelPolicy.ts'
import {
  createChannelDirectMessageThreadResolver,
  type ChannelDirectMessageThreadResolverServer
} from './channelDirectMessageRuntime.ts'

function createChannelUser(overrides: Partial<ChannelUserRecord> = {}): ChannelUserRecord {
  return {
    id: 'channel-user-1',
    platform: 'telegram',
    externalUserId: 'external-user-1',
    username: 'TestUser',
    label: '',
    status: 'allowed',
    role: 'guest',
    usageLimitKTokens: null,
    usedKTokens: 0,
    workspacePath: '/workspace/test-user',
    ...overrides
  }
}

function createThread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    title: 'Thread',
    updatedAt: '2026-04-28T00:00:00.000Z',
    ...overrides
  }
}

describe('createChannelDirectMessageThreadResolver', () => {
  it('creates guest threads from the channel user workspace and platform title', async () => {
    const createThreadInputs: unknown[] = []
    const server: ChannelDirectMessageThreadResolverServer = {
      findActiveChannelThread() {
        return undefined
      },
      getThreadTotalTokens() {
        return 0
      },
      setThreadModelOverride() {
        throw new Error('model override should not be changed')
      },
      async createThread(input) {
        createThreadInputs.push(input)
        return createThread('thread-1', input)
      }
    }

    const resolver = createChannelDirectMessageThreadResolver({
      platform: 'discord',
      logLabel: 'discord',
      server,
      policy: telegramPolicy,
      formatGuestThreadTitle: (channelUser) => `Discord:@${channelUser.username}`
    })

    const result = await resolver(
      createChannelUser({
        platform: 'discord',
        workspacePath: '/workspace/discord-user'
      })
    )

    assert.equal(result.thread.id, 'thread-1')
    assert.deepEqual(createThreadInputs, [
      {
        source: 'discord',
        channelUserId: 'channel-user-1',
        workspacePath: '/workspace/discord-user',
        title: 'Discord:@TestUser'
      }
    ])
  })

  it('carries owner handoff workspace through the shared resolver', async () => {
    const createThreadInputs: unknown[] = []
    const existing = createThread('thread-existing', {
      workspacePath: '/workspace/owner',
      source: 'telegram',
      channelUserId: 'channel-user-1'
    })
    const server: ChannelDirectMessageThreadResolverServer = {
      findActiveChannelThread() {
        return existing
      },
      getThreadTotalTokens() {
        return 100
      },
      setThreadModelOverride() {
        throw new Error('owner model override should not be changed')
      },
      async createThread(input) {
        createThreadInputs.push(input)
        return createThread('thread-handoff', input)
      }
    }

    const resolver = createChannelDirectMessageThreadResolver({
      platform: 'telegram',
      logLabel: 'telegram',
      server,
      policy: {
        ...telegramPolicy,
        contextTokenLimit: 50,
        threadReuseWindowMs: 60_000
      },
      formatGuestThreadTitle: (channelUser) => `Telegram:@${channelUser.username}`
    })

    const result = await resolver(createChannelUser({ role: 'owner' }))

    assert.equal(result.thread.id, 'thread-handoff')
    assert.deepEqual(createThreadInputs, [
      {
        source: 'telegram',
        channelUserId: 'channel-user-1',
        workspacePath: '/workspace/owner',
        handoffFromThreadId: 'thread-existing'
      }
    ])
  })
})
