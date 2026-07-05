import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackRpcHost } from './loopbackRpcHost.ts'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

interface EventfulTarget {
  listeners: Set<(event: unknown) => void>
  emit: (event: unknown) => void
  echo: (input: { a: number }) => Promise<{ a: number }>
}

function createEventfulTarget(): EventfulTarget {
  const listeners = new Set<(event: unknown) => void>()
  return {
    listeners,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event)
      }
    },
    echo: async (input) => input
  }
}

test('proxy calls round-trip through the structured-clone boundary', async () => {
  let seen: { a: number } | null = null
  const target = {
    record: async (input: { a: number }): Promise<{ doubled: number }> => {
      seen = input
      return { doubled: input.a * 2 }
    }
  }
  const host = createLoopbackRpcHost(target)

  const payload = { a: 21 }
  const resultPromise = host.proxy.record(payload)
  payload.a = 999
  const result = await resultPromise

  assert.deepEqual(result, { doubled: 42 })
  assert.deepEqual(seen, { a: 21 })
})

test('forwards target events to client subscribers', async () => {
  const target = createEventfulTarget()
  const host = createLoopbackRpcHost(target, {
    subscribe: (listener) => {
      target.listeners.add(listener)
      return () => {
        target.listeners.delete(listener)
      }
    }
  })
  const received: unknown[] = []
  host.client.subscribe((event) => received.push(event))

  target.emit({ type: 'thread.updated', threadId: 't-1' })
  await settle()

  assert.deepEqual(received, [{ type: 'thread.updated', threadId: 't-1' }])
})

test('supports progress callbacks through client.call', async () => {
  const target = {
    stream: async (input: { text: string }, onDelta: (delta: string) => void): Promise<string> => {
      onDelta('a')
      onDelta('b')
      return `${input.text}:done`
    }
  }
  const host = createLoopbackRpcHost(target)
  const deltas: unknown[] = []

  const result = await host.client.call('stream', [{ text: 'x' }], {
    onProgress: (value) => deltas.push(value)
  })

  assert.deepEqual(deltas, ['a', 'b'])
  assert.equal(result, 'x:done')
})

test('rejects non-clonable arguments instead of passing live objects through', async () => {
  const target = {
    take: async (input: unknown): Promise<unknown> => input
  }
  const host = createLoopbackRpcHost(target)

  await assert.rejects(host.proxy.take({ callback: () => 1 }))
})

test('dispose rejects pending calls, rejects later calls, and stops event forwarding', async () => {
  const target = createEventfulTarget()
  Object.assign(target, {
    hang: async (): Promise<void> => new Promise<void>(() => undefined)
  })
  const host = createLoopbackRpcHost(target as EventfulTarget & { hang: () => Promise<void> }, {
    subscribe: (listener) => {
      target.listeners.add(listener)
      return () => {
        target.listeners.delete(listener)
      }
    }
  })
  const received: unknown[] = []
  host.client.subscribe((event) => received.push(event))

  const pending = host.client.call('hang', [])
  await settle()
  host.dispose()

  await assert.rejects(pending, /RPC transport closed/)
  await assert.rejects(host.client.call('hang', []), /RPC transport closed/)
  assert.equal(target.listeners.size, 0)
  target.emit('after-dispose')
  await settle()
  assert.deepEqual(received, [])
})
