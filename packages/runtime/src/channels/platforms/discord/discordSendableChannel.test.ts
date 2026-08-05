import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannelManager } from 'discord.js'

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
