import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannelManager, Client, Events, UserManager } from 'discord.js'

import type { ChannelUserRecord } from '@yachiyo/shared/protocol'
import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import type { UpdateReceiptLease } from '../../shared/sendWithUpdateReceipt.ts'
import { createDiscordService, resolveSendableChannel } from './discordService.ts'

function source(input: {
  cached?: unknown
  fetched?: unknown
  onFetch?: () => void
  fetchRejects?: boolean
}): { cache: { get: () => unknown }; fetch: () => Promise<unknown> } {
  return {
    cache: { get: (): unknown => input.cached },
    fetch: async (): Promise<unknown> => {
      input.onFetch?.()
      if (input.fetchRejects) throw new Error('discord api unavailable')
      return input.fetched
    }
  }
}

const sendable = { send: async (): Promise<unknown> => 'sent' }

test('a cached channel is used without touching the network', async () => {
  let fetched = false
  const channel = await resolveSendableChannel(
    source({ cached: sendable, onFetch: () => (fetched = true) }),
    'chan-1'
  )
  assert.equal(channel, sendable)
  assert.equal(fetched, false, 'a cache hit must not cost an API call')
})

/**
 * The whole point: a cold cache after restart is not evidence the channel is
 * gone. This used to return silently, so the caller believed it had delivered
 * a message that was never sent.
 */
test('a cache miss fetches the channel and sends to it', async () => {
  let fetched = false
  const channel = await resolveSendableChannel(
    source({ cached: undefined, fetched: sendable, onFetch: () => (fetched = true) }),
    'chan-1'
  )
  assert.equal(fetched, true)
  assert.equal(channel, sendable)
})

test('a channel that cannot be resolved is rejected, not skipped', async () => {
  await assert.rejects(
    () => resolveSendableChannel(source({ cached: undefined, fetched: null }), 'chan-1'),
    /not available to send to/
  )
})

test('a fetched object with no send capability is rejected', async () => {
  await assert.rejects(
    () => resolveSendableChannel(source({ cached: undefined, fetched: { id: 'x' } }), 'chan-1'),
    /not available to send to/
  )
})

/** A failing API call is still a failure to deliver, not a silent skip. */
test('a fetch that throws surfaces as a send failure', async () => {
  await assert.rejects(
    () => resolveSendableChannel(source({ cached: undefined, fetchRejects: true }), 'chan-1'),
    /not available to send to/
  )
})

test('a cached entry without send falls through to fetch rather than being trusted', async () => {
  const channel = await resolveSendableChannel(
    source({ cached: { id: 'not-sendable' }, fetched: sendable }),
    'chan-1'
  )
  assert.equal(channel, sendable)
})

test('carries a deferred update receipt on the next Discord outbound', async (t) => {
  const events: string[] = []
  t.mock.method(ChannelManager.prototype, 'fetch', async () => ({
    send: async (text: string) => {
      events.push(`send:${text}`)
    }
  }))

  const lease: UpdateReceiptLease = {
    async claim(channelId) {
      events.push(`claim:${channelId}`)
      return { claimToken: 'claim-1', message: 'update receipt' }
    },
    async ack(claimToken) {
      events.push(`ack:${claimToken}`)
    },
    async release(claimToken) {
      events.push(`release:${claimToken}`)
    }
  }
  const server = {
    listChannelUsers: () => [],
    listChannelGroups: () => [
      {
        id: 'discord-group-1',
        platform: 'discord',
        externalGroupId: 'channel-1'
      }
    ]
  } as unknown as YachiyoServer

  const service = createDiscordService({
    botToken: 'token',
    server,
    updateReceiptLease: lease
  })

  await service.sendMessage('channel-1', 'ordinary reply')

  assert.deepEqual(events, [
    'claim:discord-group-1',
    'send:update receipt\n\nordinary reply',
    'ack:claim-1'
  ])
})

test('resolves a stored Discord user ID to its DM channel after restart', async (t) => {
  const events: string[] = []
  t.mock.method(UserManager.prototype, 'createDM', async (userId: string) => {
    events.push(`create-dm:${userId}`)
    return { id: 'dm-channel-1' } as never
  })
  t.mock.method(ChannelManager.prototype, 'fetch', async (channelId: string) => ({
    send: async (text: string) => {
      events.push(`send:${channelId}:${text}`)
    }
  }))

  const server = {
    listChannelUsers: () => [
      {
        id: 'discord-user-1',
        platform: 'discord',
        externalUserId: 'user-1'
      }
    ],
    listChannelGroups: () => []
  } as unknown as YachiyoServer
  const service = createDiscordService({
    botToken: 'token',
    server,
    updateReceiptLease: {
      async claim(channelId) {
        events.push(`claim:${channelId}`)
        return { claimToken: 'claim-1', message: 'update receipt' }
      },
      async ack(claimToken) {
        events.push(`ack:${claimToken}`)
      },
      async release(claimToken) {
        events.push(`release:${claimToken}`)
      }
    }
  })

  await service.sendDirectMessage('user-1', 'ordinary reply')

  assert.deepEqual(events, [
    'create-dm:user-1',
    'claim:discord-user-1',
    'send:dm-channel-1:update receipt\n\nordinary reply',
    'ack:claim-1'
  ])
})

test('an inbound Discord DM claims the receipt by user ID, not DM channel ID', async (t) => {
  const events: string[] = []
  let onMessage: ((message: unknown) => void) | undefined
  const clientEvents = Client.prototype as unknown as {
    on(event: string, listener: (message: unknown) => void): Client
  }
  t.mock.method(clientEvents, 'on', function (this: Client, event, listener) {
    if (event === Events.MessageCreate) onMessage = listener
    return this
  })

  let resolveAcked!: () => void
  const acked = new Promise<void>((resolve) => {
    resolveAcked = resolve
  })
  t.mock.method(ChannelManager.prototype, 'fetch', async () => ({
    send: async (text: string) => {
      events.push(`send:${text}`)
    }
  }))

  const users: ChannelUserRecord[] = []
  const server = {
    listChannelUsers: () => users,
    listChannelGroups: () => [],
    createChannelUser: (user: Omit<ChannelUserRecord, 'usedKTokens'>) => {
      const record = { ...user, usedKTokens: 0 }
      users.push(record)
      return record
    }
  } as unknown as YachiyoServer
  createDiscordService({
    botToken: 'token',
    server,
    updateReceiptLease: {
      async claim(channelId) {
        events.push(`claim:${channelId}`)
        return { claimToken: 'claim-1', message: 'update receipt' }
      },
      async ack(claimToken) {
        events.push(`ack:${claimToken}`)
        resolveAcked()
      },
      async release(claimToken) {
        events.push(`release:${claimToken}`)
      }
    }
  })

  assert.ok(onMessage, 'Discord MessageCreate listener was not registered')
  onMessage({
    author: { bot: false, id: 'user-1', username: 'TestUser' },
    channel: { id: 'dm-channel-1', isDMBased: () => true },
    guild: null,
    content: 'hello'
  })
  await acked

  assert.equal(users[0]?.externalUserId, 'user-1')
  assert.deepEqual(events, [
    'claim:dc-user-1',
    "send:update receipt\n\nHey! I've let my owner know you'd like to chat. I won't send any more messages until they approve you – sit tight!",
    'ack:claim-1'
  ])
})

test('rechecks the deadline after an async Discord channel lookup', async (t) => {
  let now = 100
  let sent = false
  t.mock.method(Date, 'now', () => now)
  t.mock.method(ChannelManager.prototype, 'fetch', async () => {
    now = 201
    return {
      send: async () => {
        sent = true
      }
    }
  })
  const server = {
    listChannelUsers: () => [],
    listChannelGroups: () => [
      { id: 'discord-group-1', platform: 'discord', externalGroupId: 'channel-1' }
    ]
  } as unknown as YachiyoServer
  const service = createDiscordService({
    botToken: 'token',
    server,
    updateReceiptLease: {
      claim: async () => undefined,
      ack: async () => {},
      release: async () => {}
    }
  })

  await assert.rejects(
    () => service.sendMessage('channel-1', 'announce', { notAfterMs: 200 }),
    /expired before dispatch/
  )
  assert.equal(sent, false)
})

test('rechecks the deadline after resolving a Discord user DM channel', async (t) => {
  let now = 100
  let sent = false
  t.mock.method(Date, 'now', () => now)
  t.mock.method(UserManager.prototype, 'createDM', async () => {
    now = 201
    return { id: 'dm-channel-1' } as never
  })
  t.mock.method(ChannelManager.prototype, 'fetch', async () => ({
    send: async () => {
      sent = true
    }
  }))
  const server = {
    listChannelUsers: () => [
      { id: 'discord-user-1', platform: 'discord', externalUserId: 'user-1' }
    ],
    listChannelGroups: () => []
  } as unknown as YachiyoServer
  const service = createDiscordService({
    botToken: 'token',
    server,
    updateReceiptLease: {
      claim: async () => undefined,
      ack: async () => {},
      release: async () => {}
    }
  })

  await assert.rejects(
    () => service.sendDirectMessage('user-1', 'announce', { notAfterMs: 200 }),
    /expired before dispatch/
  )
  assert.equal(sent, false)
})
