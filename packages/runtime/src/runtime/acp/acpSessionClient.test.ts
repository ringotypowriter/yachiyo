import assert from 'node:assert/strict'
import test from 'node:test'

import type { AcpStreamAdapter } from './acpStreamAdapter.ts'
import { continueAcpSession, type AcpWarmSession } from './acpSessionClient.ts'

test('continueAcpSession removes every abort listener after a normal prompt', async () => {
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const signal = {
    aborted: false,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'abort') listeners.add(listener)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'abort') listeners.delete(listener)
    }
  } as AbortSignal
  const session = {
    proc: { pid: 4120 },
    connection: {
      prompt: () => Promise.resolve({ stopReason: 'end_turn' }),
      cancel: () => Promise.resolve()
    },
    sessionId: 'session-1',
    procExited: new Promise<void>(() => {}),
    adapterRef: { current: {} }
  } as unknown as AcpWarmSession
  const adapter = {
    yoloClient: {},
    onStderr(data: Buffer) {
      void data
    },
    getLastMessageText: () => 'done'
  } as unknown as AcpStreamAdapter

  const result = await continueAcpSession(session, [], adapter, {
    abortSignal: signal,
    keepAlive: true
  })

  assert.equal(result.lastMessageText, 'done')
  assert.equal(listeners.size, 0)
})
