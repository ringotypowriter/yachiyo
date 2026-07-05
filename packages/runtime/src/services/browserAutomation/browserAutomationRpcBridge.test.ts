import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

import {
  createBrowserAutomationRpcTarget,
  createRpcBrowserAutomationBackend
} from './browserAutomationRpcBridge.ts'
import {
  BROWSER_AUTOMATION_TOOL_METHODS,
  type BrowserAutomationToolBackend
} from './browserAutomationToolBackend.ts'

function createFakeBackend(calls: Array<{ method: string; input: unknown }>): {
  backend: BrowserAutomationToolBackend
  failNext: (message: string) => void
} {
  let failureMessage: string | null = null
  const record =
    (method: string, result: unknown) =>
    async (input: unknown): Promise<unknown> => {
      if (failureMessage) {
        const message = failureMessage
        failureMessage = null
        throw new Error(message)
      }
      calls.push({ method, input })
      return result
    }

  const backend = Object.fromEntries(
    BROWSER_AUTOMATION_TOOL_METHODS.map((method) => [
      method,
      record(method, { url: `https://example.test/${method}` })
    ])
  ) as unknown as BrowserAutomationToolBackend

  return {
    backend,
    failNext: (message) => {
      failureMessage = message
    }
  }
}

interface Bridge {
  remote: BrowserAutomationToolBackend
  calls: Array<{ method: string; input: unknown }>
  failNext: (message: string) => void
}

function createBridge(): Bridge {
  const calls: Array<{ method: string; input: unknown }> = []
  const { backend, failNext } = createFakeBackend(calls)
  const [mainTransport, utilityTransport] = createLoopbackTransportPair()
  serveRpcTarget({ transport: mainTransport, target: createBrowserAutomationRpcTarget(backend) })
  const remote = createRpcBrowserAutomationBackend(createRpcClient(utilityTransport))
  return { remote, calls, failNext }
}

test('forwards every tool method over RPC with the input intact', async () => {
  const { remote, calls } = createBridge()

  const opened = await remote.open({ threadId: 't-1', session: 's-1', url: 'https://a.test' })
  const state = await remote.click({ threadId: 't-1', session: 's-1', ref: 'e3' })

  assert.deepEqual(opened, { url: 'https://example.test/open' })
  assert.deepEqual(state, { url: 'https://example.test/click' })
  assert.deepEqual(calls, [
    { method: 'open', input: { threadId: 't-1', session: 's-1', url: 'https://a.test' } },
    { method: 'click', input: { threadId: 't-1', session: 's-1', ref: 'e3' } }
  ])
})

test('implements the complete tool backend surface', () => {
  const { remote } = createBridge()

  for (const method of BROWSER_AUTOMATION_TOOL_METHODS) {
    assert.equal(typeof remote[method], 'function', `missing bridge method: ${method}`)
  }
})

test('propagates backend errors with their message', async () => {
  const { remote, failNext } = createBridge()
  failNext('Unknown browser ref: e99')

  await assert.rejects(remote.click({ threadId: 't-1', session: 's-1', ref: 'e99' }), {
    message: 'Unknown browser ref: e99'
  })
})

test('rejects AbortSignal inputs instead of losing cancellation silently', async () => {
  const { remote, calls } = createBridge()

  await assert.rejects(
    remote.waitForFunction({
      threadId: 't-1',
      session: 's-1',
      predicate: 'true',
      timeoutMs: 1000,
      signal: new AbortController().signal
    }),
    /AbortSignal cannot cross the RPC boundary/
  )
  assert.deepEqual(calls, [])
})
