import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSendableChannel } from './discordService.ts'

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
