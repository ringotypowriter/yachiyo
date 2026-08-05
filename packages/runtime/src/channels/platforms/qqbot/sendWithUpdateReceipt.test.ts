import assert from 'node:assert/strict'
import test from 'node:test'

import { sendWithUpdateReceipt } from './sendWithUpdateReceipt.ts'

function lease(overrides: Partial<Record<'claim' | 'ack' | 'release', unknown>> = {}): {
  lease: Parameters<typeof sendWithUpdateReceipt>[0]['lease']
  calls: string[]
} {
  const calls: string[] = []
  const base = {
    claim: async (): Promise<{ claimToken: string; message: string } | undefined> => {
      calls.push('claim')
      return { claimToken: 'token-1', message: '已更新到 1.1.0' }
    },
    ack: async (): Promise<void> => {
      calls.push('ack')
    },
    release: async (): Promise<void> => {
      calls.push('release')
    },
    ...overrides
  }
  return { lease: base as Parameters<typeof sendWithUpdateReceipt>[0]['lease'], calls }
}

test('an owed receipt is prepended to the reply and acknowledged once sent', async () => {
  const { lease: l, calls } = lease()
  const sent: string[] = []

  await sendWithUpdateReceipt({
    channelId: 'chan-1',
    text: 'Here is the answer.',
    send: async (body) => {
      sent.push(body)
    },
    lease: l
  })

  assert.deepEqual(sent, ['已更新到 1.1.0\n\nHere is the answer.'])
  assert.deepEqual(calls, ['claim', 'ack'])
})

/** Nothing owed: the reply must be untouched and no lease traffic at all. */
test('with nothing owed the reply is sent verbatim', async () => {
  const { lease: l, calls } = lease()
  l!.claim = async (): Promise<undefined> => {
    calls.push('claim')
    return undefined
  }
  const sent: string[] = []

  await sendWithUpdateReceipt({
    channelId: 'chan-1',
    text: 'Here is the answer.',
    send: async (body) => {
      sent.push(body)
    },
    lease: l
  })

  assert.deepEqual(sent, ['Here is the answer.'])
  assert.deepEqual(calls, ['claim'], 'nothing to acknowledge')
})

/**
 * A send that fails delivered nothing, so the receipt is still owed. Acking
 * here would silently consume it and the user would never be told.
 */
test('a failed send releases the lease instead of acknowledging it', async () => {
  const { lease: l, calls } = lease()

  await assert.rejects(
    () =>
      sendWithUpdateReceipt({
        channelId: 'chan-1',
        text: 'Here is the answer.',
        send: async () => {
          throw new Error('rate limited')
        },
        lease: l
      }),
    /rate limited/
  )

  assert.deepEqual(calls, ['claim', 'release'])
  assert.ok(!calls.includes('ack'), 'never acknowledge a receipt that did not go out')
})

/** The reply matters more than the bookkeeping: a broken lease must not block it. */
test('a claim that throws still delivers the reply, unprefixed', async () => {
  const stages: string[] = []
  const { lease: l } = lease({
    claim: async () => {
      throw new Error('rpc down')
    }
  })
  const sent: string[] = []

  await sendWithUpdateReceipt({
    channelId: 'chan-1',
    text: 'Here is the answer.',
    send: async (body) => {
      sent.push(body)
    },
    lease: l,
    onError: (stage) => stages.push(stage)
  })

  assert.deepEqual(sent, ['Here is the answer.'])
  assert.deepEqual(stages, ['claim'])
})

test('an ack that throws does not fail the send that already succeeded', async () => {
  const stages: string[] = []
  const { lease: l } = lease({
    ack: async () => {
      throw new Error('rpc down')
    }
  })

  await sendWithUpdateReceipt({
    channelId: 'chan-1',
    text: 'Here is the answer.',
    send: async () => {},
    lease: l,
    onError: (stage) => stages.push(stage)
  })

  assert.deepEqual(stages, ['ack'])
})

test('with no lease configured nothing is claimed and the text is unchanged', async () => {
  const sent: string[] = []
  await sendWithUpdateReceipt({
    channelId: 'chan-1',
    text: 'Here is the answer.',
    send: async (body) => {
      sent.push(body)
    }
  })
  assert.deepEqual(sent, ['Here is the answer.'])
})

/** An unknown user has no channel record, so there is nobody to owe. */
test('an unresolved channel id skips the lease entirely', async () => {
  const { lease: l, calls } = lease()
  await sendWithUpdateReceipt({
    channelId: undefined,
    text: 'Here is the answer.',
    send: async () => {},
    lease: l
  })
  assert.deepEqual(calls, [])
})
