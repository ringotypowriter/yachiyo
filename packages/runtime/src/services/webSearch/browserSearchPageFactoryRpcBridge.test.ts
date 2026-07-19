import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

import {
  createBrowserSearchPageFactoryRpcTarget,
  createRpcBrowserSearchPageFactory
} from './browserSearchPageFactoryRpcBridge.ts'
import type { BrowserSearchPage, BrowserSearchPageFactory } from './browserSearchSession.ts'

interface FakePageLog {
  created: string[]
  disposed: number
  loaded: string[]
  loadOptions: unknown[]
  evaluated: string[]
}

function createFakeFactory(input: { evaluateResults?: unknown[] } = {}): {
  factory: BrowserSearchPageFactory
  log: FakePageLog
} {
  const log: FakePageLog = {
    created: [],
    disposed: 0,
    loaded: [],
    loadOptions: [],
    evaluated: []
  }
  const evaluateResults = [...(input.evaluateResults ?? [])]

  const factory: BrowserSearchPageFactory = {
    createPage: async (profilePath) => {
      log.created.push(profilePath)
      const page: BrowserSearchPage = {
        evaluate: async <TResult>(script: string): Promise<TResult> => {
          log.evaluated.push(script)
          return (evaluateResults.length > 0 ? evaluateResults.shift() : 'evaluated') as TResult
        },
        getURL: async () => 'https://example.test/current',
        loadURL: async (url, options?: unknown) => {
          log.loaded.push(url)
          log.loadOptions.push(options)
        },
        waitForFunction: async () => {
          throw new Error('main-side waitForFunction must not be reached over RPC')
        }
      }
      return page
    },
    disposePage: async () => {
      log.disposed += 1
    }
  }

  return { factory, log }
}

function createBridge(input: { evaluateResults?: unknown[] } = {}): {
  remote: BrowserSearchPageFactory
  log: FakePageLog
} {
  const { factory, log } = createFakeFactory(input)
  const [mainTransport, utilityTransport] = createLoopbackTransportPair()
  serveRpcTarget({
    transport: mainTransport,
    target: createBrowserSearchPageFactoryRpcTarget(factory)
  })
  const remote = createRpcBrowserSearchPageFactory(createRpcClient(utilityTransport))
  return { remote, log }
}

test('proxies page lifecycle and page operations over RPC', async () => {
  const { remote, log } = createBridge()

  const page = await remote.createPage('/profiles/search')
  await page.loadURL('https://example.test/query')
  const url = await page.getURL()
  const evaluated = await page.evaluate<string>('document.title')
  await remote.disposePage(page)

  assert.deepEqual(log.created, ['/profiles/search'])
  assert.deepEqual(log.loaded, ['https://example.test/query'])
  assert.equal(url, 'https://example.test/current')
  assert.equal(evaluated, 'evaluated')
  assert.deepEqual(log.evaluated, ['document.title'])
  assert.equal(log.disposed, 1)
})

test('proxies URL-encoded POST data over RPC', async () => {
  const { remote, log } = createBridge()
  const post = {
    body: 'q=yachiyo+electron&kl=us-en',
    contentType: 'application/x-www-form-urlencoded'
  }

  const page = await remote.createPage('/profiles/search')
  await page.loadURL('https://html.duckduckgo.com/html/', { post })

  assert.deepEqual(log.loaded, ['https://html.duckduckgo.com/html/'])
  assert.deepEqual(log.loadOptions, [{ post }])
})

test('waitForFunction polls the remote predicate locally until it passes', async () => {
  const { remote, log } = createBridge({ evaluateResults: [false, false, true] })

  const page = await remote.createPage('/profiles/search')
  await page.waitForFunction({ predicate: 'ready()', timeoutMs: 1000, pollIntervalMs: 1 })

  assert.deepEqual(log.evaluated, ['ready()', 'ready()', 'ready()'])
})

test('waitForFunction times out with the standard message', async () => {
  const { remote } = createBridge({ evaluateResults: Array(100).fill(false) })

  const page = await remote.createPage('/profiles/search')

  await assert.rejects(
    page.waitForFunction({ predicate: 'ready()', timeoutMs: 5, pollIntervalMs: 1 }),
    /Timed out after 5ms waiting for page readiness\./
  )
})

test('waitForFunction honors an already-aborted signal without touching the page', async () => {
  const { remote, log } = createBridge()
  const controller = new AbortController()
  controller.abort()

  const page = await remote.createPage('/profiles/search')

  await assert.rejects(
    page.waitForFunction({
      predicate: 'ready()',
      timeoutMs: 1000,
      signal: controller.signal
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      return true
    }
  )
  assert.deepEqual(log.evaluated, [])
})

test('operations on a disposed page reject loudly', async () => {
  const { remote } = createBridge()

  const page = await remote.createPage('/profiles/search')
  await remote.disposePage(page)

  await assert.rejects(page.evaluate('document.title'), /Unknown browser search page/)
})

test('disposing a page the factory did not create rejects loudly', async () => {
  const { remote } = createBridge()

  const foreignPage: BrowserSearchPage = {
    evaluate: async () => undefined as never,
    getURL: async () => '',
    loadURL: async () => {},
    waitForFunction: async () => {}
  }

  await assert.rejects(remote.disposePage(foreignPage), /was not created by this factory/)
})
