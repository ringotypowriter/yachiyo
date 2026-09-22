import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import test from 'node:test'
import { createSettingsStore, normalizeSettingsConfig } from '../../settings/settingsStore.ts'
import { createResponsesWebSocketFetch, ResponsesWebSocketPool } from './responsesWebSocket.ts'
import {
  createResponsesWebSocketSupportStore,
  responsesEndpointKey
} from './responsesWebSocketSupport.ts'

function fixture(baseUrl: string): {
  store: ReturnType<typeof createSettingsStore>
  path: string
  close: () => void
} {
  const directory = mkdtempSync(join(tmpdir(), 'responses-support-'))
  const path = join(directory, 'config.toml')
  const store = createSettingsStore(path)
  store.write(
    normalizeSettingsConfig({
      providers: [
        {
          id: 'one',
          name: 'One',
          type: 'openai-responses',
          apiKey: '',
          baseUrl,
          modelList: { enabled: ['model'], disabled: [] }
        },
        {
          id: 'two',
          name: 'Two',
          type: 'openai-responses',
          apiKey: '',
          baseUrl,
          modelList: { enabled: ['model'], disabled: [] }
        }
      ]
    })
  )
  return { store, path, close: () => rmSync(directory, { recursive: true, force: true }) }
}

const post = { method: 'POST', body: JSON.stringify({ model: 'model', stream: true }) }

for (const status of [404, 405, 501, 400, 401, 403, 426, 429, 500, 503, 'timeout'] as const) {
  test(`handshake ${status}: only confirmed unsupported persists across restart`, async () => {
    let handshakes = 0
    const server = createServer()
    const sockets = new Set<import('node:stream').Duplex>()
    server.on('upgrade', (_request, socket) => {
      handshakes++
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      if (status !== 'timeout')
        socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/responses`
    const f = fixture(url.replace('/responses', ''))
    const pool = new ResponsesWebSocketPool()
    let httpCalls = 0
    const baseFetch = async (): Promise<Response> => {
      httpCalls++
      return new Response('HTTP')
    }
    const makeFetch = (
      providerKey = 'one',
      freshPool = pool,
      sessionId = 'session'
    ): typeof globalThis.fetch =>
      createResponsesWebSocketFetch(baseFetch, {
        sessionId,
        providerKey,
        pool: freshPool,
        connectTimeoutMs: 100,
        supportStore: createResponsesWebSocketSupportStore(createSettingsStore(f.path))
      })
    const unsupported = status === 404 || status === 405 || status === 501
    try {
      const fetch = makeFetch()
      assert.equal(await (await fetch(url, post)).text(), 'HTTP')
      assert.equal(handshakes, 1)
      assert.equal(
        !!f.store.read().providers[0]?.responsesWebSocketUnsupportedEndpoint,
        unsupported
      )
      await fetch(url, post)
      assert.equal(handshakes, 1) // saved fallback or temporary cooldown
      if (unsupported) {
        const settings = f.store.read()
        delete settings.providers[0]!.responsesWebSocketUnsupportedEndpoint
        f.store.write(settings)
        await fetch(url, post)
        assert.equal(handshakes, 2) // Retry works without clearing the process pool.
      }
      pool.closeAll()
      const restarted = makeFetch('one', new ResponsesWebSocketPool(), 'after-restart')
      await restarted(url, post)
      assert.equal(handshakes, 2)
      if (unsupported) {
        // Other providers and other endpoints must probe independently.
        await makeFetch('two')(url, post)
        assert.equal(handshakes, 3)
        await fetch(url.replace('/responses', '/v2/responses'), post)
        assert.equal(handshakes, 4)
        assert.equal(
          f.store.read().providers[0]?.responsesWebSocketUnsupportedEndpoint,
          responsesEndpointKey(url)
        )
        // The UI's existing provider-save path clears this field. Same fetch/pool must retry.
        const settings = f.store.read()
        delete settings.providers[0]!.responsesWebSocketUnsupportedEndpoint
        f.store.write(settings)
        await fetch(url, post)
        assert.equal(handshakes, 5)
      }
      assert.ok(httpCalls >= 3)
    } finally {
      pool.closeAll()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      f.close()
    }
  })
}

test('support store merges latest provider, guards endpoint edits/removal, and persists only digests', () => {
  const baseUrl = 'https://user:password@example.test/private-token/v1'
  const f = fixture(baseUrl)
  const support = createResponsesWebSocketSupportStore(f.store)
  const endpoint = responsesEndpointKey(`${baseUrl}/responses`)
  try {
    const edited = f.store.read()
    edited.providers[0]!.name = 'Renamed'
    edited.providers[0]!.modelList.enabled.push('new-model')
    f.store.write(edited)
    support.markUnsupported('one', endpoint)
    const reloaded = createSettingsStore(f.path).read()
    assert.equal(reloaded.providers[0]?.name, 'Renamed')
    assert.deepEqual(reloaded.providers[0]?.modelList.enabled, ['model', 'new-model'])
    assert.equal(reloaded.providers[0]?.responsesWebSocketUnsupportedEndpoint, endpoint)
    const persistedLine = readFileSync(f.path, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('responsesWebSocketUnsupportedEndpoint'))!
    assert.match(persistedLine, /"[a-f0-9]{64}"/)
    assert.ok(!persistedLine.includes('password'))
    reloaded.providers[0]!.baseUrl = 'https://changed.test/v1'
    delete reloaded.providers[0]!.responsesWebSocketUnsupportedEndpoint
    f.store.write(reloaded)
    support.markUnsupported('one', endpoint)
    assert.equal(f.store.read().providers[0]?.responsesWebSocketUnsupportedEndpoint, undefined)
    reloaded.providers = reloaded.providers.filter((provider) => provider.id !== 'one')
    f.store.write(reloaded)
    support.markUnsupported('one', endpoint)
    assert.equal(f.store.read().providers.length, 1)
  } finally {
    f.close()
  }
})
