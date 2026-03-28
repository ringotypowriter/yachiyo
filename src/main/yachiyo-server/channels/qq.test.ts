import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { ChannelUserRecord } from '../../../shared/yachiyo/protocol.ts'
import { routeQQMessage, type QQChannelStorage } from './qq.ts'

function createMockStorage(users: ChannelUserRecord[] = []): QQChannelStorage {
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

describe('routeQQMessage', () => {
  it('creates a pending user on first contact but stays silent', () => {
    const storage = createMockStorage()
    const result = routeQQMessage({ userId: '12345', nickname: 'TestUser', text: 'hi' }, storage)

    assert.equal(result.kind, 'blocked')
    assert.ok(!('reply' in result))

    const user = storage.findChannelUser('qq', '12345')
    assert.ok(user)
    assert.equal(user!.status, 'pending')
    assert.equal(user!.platform, 'qq')
    assert.equal(user!.id, 'qq-12345')
  })

  it('blocks repeated messages from pending users', () => {
    const storage = createMockStorage([
      {
        id: 'qq-12345',
        platform: 'qq',
        externalUserId: '12345',
        username: 'TestUser',
        status: 'pending',
        role: 'guest',
        usageLimitKTokens: null,
        usedKTokens: 0,
        workspacePath: '/tmp/qq-12345'
      }
    ])

    const result = routeQQMessage(
      { userId: '12345', nickname: 'TestUser', text: 'hello?' },
      storage
    )
    assert.equal(result.kind, 'blocked')
  })

  it('blocks messages from blocked users', () => {
    const storage = createMockStorage([
      {
        id: 'qq-12345',
        platform: 'qq',
        externalUserId: '12345',
        username: 'TestUser',
        status: 'blocked',
        role: 'guest',
        usageLimitKTokens: null,
        usedKTokens: 0,
        workspacePath: '/tmp/qq-12345'
      }
    ])

    const result = routeQQMessage({ userId: '12345', nickname: 'TestUser', text: 'hi' }, storage)
    assert.equal(result.kind, 'blocked')
  })

  it('allows messages from allowed users', () => {
    const storage = createMockStorage([
      {
        id: 'qq-12345',
        platform: 'qq',
        externalUserId: '12345',
        username: 'TestUser',
        status: 'allowed',
        role: 'guest',
        usageLimitKTokens: null,
        usedKTokens: 0,
        workspacePath: '/tmp/qq-12345'
      }
    ])

    const result = routeQQMessage({ userId: '12345', nickname: 'TestUser', text: 'hi' }, storage)
    assert.equal(result.kind, 'allowed')
    assert.ok('channelUser' in result)
  })

  it('returns limit-exceeded when quota is exhausted', () => {
    const storage = createMockStorage([
      {
        id: 'qq-12345',
        platform: 'qq',
        externalUserId: '12345',
        username: 'TestUser',
        status: 'allowed',
        role: 'guest',
        usageLimitKTokens: 100,
        usedKTokens: 100,
        workspacePath: '/tmp/qq-12345'
      }
    ])

    const result = routeQQMessage({ userId: '12345', nickname: 'TestUser', text: 'hi' }, storage)
    assert.equal(result.kind, 'limit-exceeded')
    assert.ok('reply' in result)
  })
})
