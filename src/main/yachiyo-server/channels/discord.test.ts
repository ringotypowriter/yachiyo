import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { ChannelUserRecord } from '../../../shared/yachiyo/protocol.ts'
import { routeDiscordMessage, type DiscordChannelStorage } from './discord.ts'

function createMockStorage(users: ChannelUserRecord[] = []): DiscordChannelStorage {
  const store = new Map(users.map((u) => [`${u.platform}:${u.externalUserId}`, u]))
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

describe('routeDiscordMessage', () => {
  it('creates a pending user on first contact with a reply', () => {
    const storage = createMockStorage()
    const result = routeDiscordMessage(
      { externalUserId: '123456789', username: 'TestUser', text: 'hi' },
      storage
    )

    assert.equal(result.kind, 'pending')
    assert.ok('reply' in result)

    const user = storage.findChannelUser('discord', '123456789')
    assert.ok(user)
    assert.equal(user!.status, 'pending')
    assert.equal(user!.platform, 'discord')
    assert.equal(user!.id, 'dc-123456789')
  })

  it('blocks repeated messages from pending users', () => {
    const storage = createMockStorage([
      {
        id: 'dc-123456789',
        platform: 'discord',
        externalUserId: '123456789',
        username: 'TestUser',
        label: '',
        status: 'pending',
        role: 'guest',
        usageLimitKTokens: null,
        usedKTokens: 0,
        workspacePath: '/tmp/dc-123456789'
      }
    ])

    const result = routeDiscordMessage(
      { externalUserId: '123456789', username: 'TestUser', text: 'hello?' },
      storage
    )
    assert.equal(result.kind, 'blocked')
  })

  it('blocks messages from blocked users', () => {
    const storage = createMockStorage([
      {
        id: 'dc-123456789',
        platform: 'discord',
        externalUserId: '123456789',
        username: 'TestUser',
        label: '',
        status: 'blocked',
        role: 'guest',
        usageLimitKTokens: null,
        usedKTokens: 0,
        workspacePath: '/tmp/dc-123456789'
      }
    ])

    const result = routeDiscordMessage(
      { externalUserId: '123456789', username: 'TestUser', text: 'hi' },
      storage
    )
    assert.equal(result.kind, 'blocked')
  })

  it('allows messages from allowed users', () => {
    const storage = createMockStorage([
      {
        id: 'dc-123456789',
        platform: 'discord',
        externalUserId: '123456789',
        username: 'TestUser',
        label: '',
        status: 'allowed',
        role: 'guest',
        usageLimitKTokens: null,
        usedKTokens: 0,
        workspacePath: '/tmp/dc-123456789'
      }
    ])

    const result = routeDiscordMessage(
      { externalUserId: '123456789', username: 'TestUser', text: 'hi' },
      storage
    )
    assert.equal(result.kind, 'allowed')
    assert.ok('channelUser' in result)
  })

  it('returns limit-exceeded when quota is exhausted', () => {
    const storage = createMockStorage([
      {
        id: 'dc-123456789',
        platform: 'discord',
        externalUserId: '123456789',
        username: 'TestUser',
        label: '',
        status: 'allowed',
        role: 'guest',
        usageLimitKTokens: 100,
        usedKTokens: 100,
        workspacePath: '/tmp/dc-123456789'
      }
    ])

    const result = routeDiscordMessage(
      { externalUserId: '123456789', username: 'TestUser', text: 'hi' },
      storage
    )
    assert.equal(result.kind, 'limit-exceeded')
    assert.ok('reply' in result)
  })
})
