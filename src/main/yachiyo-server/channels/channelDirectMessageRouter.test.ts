import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ChannelPlatform, ChannelUserRecord } from '../../../shared/yachiyo/protocol.ts'
import {
  routeChannelDirectMessage,
  type ChannelDirectMessageStorage
} from './channelDirectMessageRouter.ts'

function createMockStorage(users: ChannelUserRecord[] = []): ChannelDirectMessageStorage {
  const store = new Map(users.map((user) => [`${user.platform}:${user.externalUserId}`, user]))
  return {
    findChannelUser(platform, externalUserId) {
      return store.get(`${platform}:${externalUserId}`)
    },
    createChannelUser(user) {
      const record: ChannelUserRecord = { ...user, usedKTokens: 0 }
      store.set(`${record.platform}:${record.externalUserId}`, record)
      return record
    }
  }
}

function createUser(
  platform: ChannelPlatform,
  overrides: Partial<ChannelUserRecord> = {}
): ChannelUserRecord {
  return {
    id: `${platform}-user-1`,
    platform,
    externalUserId: 'user-1',
    username: 'TestUser',
    label: '',
    status: 'allowed',
    role: 'guest',
    usageLimitKTokens: null,
    usedKTokens: 0,
    workspacePath: `/tmp/${platform}-user-1`,
    ...overrides
  }
}

describe('routeChannelDirectMessage', () => {
  it('creates a pending Telegram user and returns the first-contact reply', () => {
    const storage = createMockStorage()

    const result = routeChannelDirectMessage(
      { platform: 'telegram', externalUserId: '42', username: 'leader' },
      storage
    )

    assert.equal(result.kind, 'pending')
    assert.ok('reply' in result)

    const created = storage.findChannelUser('telegram', '42')
    assert.ok(created)
    assert.equal(created.id, 'tg-42')
    assert.equal(created.status, 'pending')
    assert.equal(created.workspacePath.endsWith('/tg-leader'), true)
  })

  it('keeps QQ first contact silent while still registering the pending user', () => {
    const storage = createMockStorage()

    const result = routeChannelDirectMessage(
      { platform: 'qq', externalUserId: '10001', username: 'QQUser' },
      storage
    )

    assert.deepEqual(result, { kind: 'blocked' })

    const created = storage.findChannelUser('qq', '10001')
    assert.ok(created)
    assert.equal(created.id, 'qq-10001')
    assert.equal(created.status, 'pending')
    assert.equal(created.workspacePath.endsWith('/qq-10001'), true)
  })

  it('blocks pending and blocked users before reaching chat handling', () => {
    const pending = routeChannelDirectMessage(
      { platform: 'discord', externalUserId: 'user-1', username: 'TestUser' },
      createMockStorage([createUser('discord', { status: 'pending' })])
    )
    const blocked = routeChannelDirectMessage(
      { platform: 'discord', externalUserId: 'user-1', username: 'TestUser' },
      createMockStorage([createUser('discord', { status: 'blocked' })])
    )

    assert.deepEqual(pending, { kind: 'blocked' })
    assert.deepEqual(blocked, { kind: 'blocked' })
  })

  it('returns allowed users and limit replies from the shared quota logic', () => {
    const allowed = routeChannelDirectMessage(
      { platform: 'qqbot', externalUserId: 'user-1', username: 'TestUser' },
      createMockStorage([createUser('qqbot')])
    )
    const limited = routeChannelDirectMessage(
      { platform: 'qqbot', externalUserId: 'user-1', username: 'TestUser' },
      createMockStorage([
        createUser('qqbot', {
          usageLimitKTokens: 8,
          usedKTokens: 8
        })
      ])
    )

    assert.equal(allowed.kind, 'allowed')
    assert.equal(limited.kind, 'limit-exceeded')
    assert.ok('reply' in limited)
  })
})
