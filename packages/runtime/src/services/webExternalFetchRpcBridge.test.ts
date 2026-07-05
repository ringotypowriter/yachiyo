import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

import {
  createRpcWebExternalFetch,
  createWebExternalFetchRpcTarget
} from './webExternalFetchRpcBridge.ts'

interface SeenRequest {
  url: string
  method: string
  headers: Array<[string, string]>
  bodyText: string | null
  signal: AbortSignal | undefined
}

function createBridge(mainFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const [mainTransport, utilityTransport] = createLoopbackTransportPair()
  serveRpcTarget({ transport: mainTransport, target: createWebExternalFetchRpcTarget(mainFetch) })
  return createRpcWebExternalFetch(createRpcClient(utilityTransport))
}

function recordingFetch(respond: (seen: SeenRequest) => Response): {
  fetch: typeof globalThis.fetch
  seen: SeenRequest[]
} {
  const seen: SeenRequest[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request: SeenRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: [...new Headers(init?.headers).entries()],
      bodyText: init?.body ? Buffer.from(init.body as Uint8Array).toString() : null,
      signal: init?.signal ?? undefined
    }
    seen.push(request)
    return respond(request)
  }
  return { fetch, seen }
}

test('streams a chunked response with url, status, and headers preserved', async () => {
  const { fetch: mainFetch, seen } = recordingFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('hello '))
            controller.enqueue(new TextEncoder().encode('八千代'))
            controller.close()
          }
        }),
        { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain; charset=utf-8' } }
      )
  )
  const bridgedFetch = createBridge(mainFetch)

  const response = await bridgedFetch('https://example.test/page', {
    headers: { 'accept-language': 'zh-CN' },
    method: 'GET'
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await response.text(), 'hello 八千代')
  assert.equal(seen[0]?.url, 'https://example.test/page')
  assert.deepEqual(seen[0]?.headers, [['accept-language', 'zh-CN']])
})

test('reports the final url after redirects', async () => {
  const { fetch: mainFetch } = recordingFetch(() => {
    const response = new Response('moved', { status: 200 })
    Object.defineProperty(response, 'url', { value: 'https://example.test/final' })
    return response
  })
  const bridgedFetch = createBridge(mainFetch)

  const response = await bridgedFetch('https://example.test/start')

  assert.equal(response.url, 'https://example.test/final')
})

test('forwards request bodies and non-GET methods', async () => {
  const { fetch: mainFetch, seen } = recordingFetch(() => new Response('ok'))
  const bridgedFetch = createBridge(mainFetch)

  await bridgedFetch('https://example.test/api', {
    method: 'POST',
    body: Buffer.from('payload-字节'),
    headers: { 'content-type': 'application/octet-stream' }
  })

  assert.equal(seen[0]?.method, 'POST')
  assert.equal(seen[0]?.bodyText, 'payload-字节')
})

test('handles null-body statuses without constructing an invalid Response', async () => {
  const { fetch: mainFetch } = recordingFetch(() => new Response(null, { status: 204 }))
  const bridgedFetch = createBridge(mainFetch)

  const response = await bridgedFetch('https://example.test/empty')

  assert.equal(response.status, 204)
  assert.equal(await response.text(), '')
})

test('error statuses resolve normally instead of rejecting', async () => {
  const { fetch: mainFetch } = recordingFetch(() => new Response('missing', { status: 404 }))
  const bridgedFetch = createBridge(mainFetch)

  const response = await bridgedFetch('https://example.test/nope')

  assert.equal(response.status, 404)
  assert.equal(await response.text(), 'missing')
})

test('network failures reject with the original message', async () => {
  const bridgedFetch = createBridge(async () => {
    throw new Error('net::ERR_CONNECTION_REFUSED')
  })

  await assert.rejects(bridgedFetch('https://example.test/down'), /ERR_CONNECTION_REFUSED/)
})

test('an aborted init.signal aborts the main-side fetch', async () => {
  let mainSawAbort = false
  const bridgedFetch = createBridge(async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        mainSawAbort = true
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  })
  const controller = new AbortController()

  const pending = bridgedFetch('https://example.test/slow', { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error)
    return true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(mainSawAbort, true)
})

test('cancelling the response body aborts the main-side stream', async () => {
  let pulls = 0
  let mainSawCancel = false
  const { fetch: mainFetch } = recordingFetch(
    (seenRequest) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            if (seenRequest.signal?.aborted) {
              mainSawCancel = true
              controller.close()
              return
            }
            controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
          }
        }),
        { status: 200 }
      )
  )
  const bridgedFetch = createBridge(mainFetch)

  const response = await bridgedFetch('https://example.test/huge')
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(mainSawCancel || pulls < 1000, true)
})

test('streaming request bodies are rejected loudly', async () => {
  const bridgedFetch = createBridge(async () => new Response('ok'))

  await assert.rejects(
    bridgedFetch('https://example.test/upload', {
      method: 'POST',
      body: new ReadableStream(),
      duplex: 'half'
    } as RequestInit),
    /request body cannot cross the RPC boundary/i
  )
})
