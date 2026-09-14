import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import electron from 'electron'
import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import {
  createBrowserAutomationRpcTarget,
  createRpcBrowserAutomationBackend
} from './browserAutomationRpcBridge.ts'
import { createElectronBrowserAutomationService } from './electronBrowserAutomationService.ts'

class FakeContents extends EventEmitter {
  destroyed = false
  closed = 0
  executeJavaScript: () => Promise<unknown> = () => new Promise(() => {})
  capturePage: () => Promise<unknown> = () => new Promise(() => {})
  loadURL: (url: string) => Promise<void> = async () => {}
  printToPDF: () => Promise<unknown> = () => new Promise(() => {})
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return 'https://example.test'
  }
  getTitle(): string {
    return 'Test'
  }
  setWindowOpenHandler(): void {
    /* No popup windows in the fake. */
  }
  close(): void {
    this.closed++
    this.destroyed = true
    this.emit('destroyed')
  }
}
function setup(
  timeout = 20,
  proxyReady = Promise.resolve()
): {
  service: ReturnType<typeof createElectronBrowserAutomationService>
  contents: FakeContents[]
} {
  const contents: FakeContents[] = []
  class FakeView {
    webContents = new FakeContents()
    constructor() {
      contents.push(this.webContents)
    }
    setBounds(): void {
      /* Geometry does not affect lifecycle tests. */
    }
  }
  const service = createElectronBrowserAutomationService({
    profilePath: '/unused',
    operationTimeoutMs: timeout,
    electron: {
      BrowserWindow: class {},
      WebContentsView: FakeView,
      session: {
        fromPath: () => ({ setProxy: () => proxyReady, setCertificateVerifyProc: () => {} })
      }
    } as unknown as typeof electron
  })
  return { service, contents }
}
const input = { threadId: 't', session: 's' }

test('snapshot deadline closes real session and rejects queued navigation', async () => {
  const { service, contents } = setup()
  try {
    await service.open(input)
    const snapshot = service.snapshot(input)
    const queued = service.getUrl(input)
    await Promise.all([assert.rejects(snapshot, /Timed out/), assert.rejects(queued, /Timed out/)])
    assert.equal(contents[0]!.closed, 1)
    assert.deepEqual(service.listSessions(input), [])
  } finally {
    service.dispose()
  }
})

for (const method of ['screenshot', 'pdf'] as const) {
  test(`${method} deadline closes session when Electron never settles`, async () => {
    const { service, contents } = setup()
    const workspacePath = await mkdtemp(join(tmpdir(), 'browser-lifecycle-'))
    try {
      await service.open(input)
      await assert.rejects(service[method]({ ...input, workspacePath }), /Timed out/)
      assert.equal(contents[0]!.closed, 1)
    } finally {
      service.dispose()
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
}

test('close bypasses hung snapshot; late result and old destroyed event cannot affect replacement', async () => {
  const { service, contents } = setup(1000)
  try {
    await service.open(input)
    // Electron may deliver destroyed after the close call has returned.
    contents[0]!.close = () => {
      contents[0]!.closed++
      contents[0]!.destroyed = true
    }
    let release!: (value: unknown) => void
    contents[0]!.executeJavaScript = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const pending = service.snapshot(input)
    const rejected = assert.rejects(pending, /closed/)
    await Promise.resolve()
    await service.close(input)
    await rejected
    await service.open(input)
    let staleRefsRead = false
    release({
      __yachiyoBrowserAutomationScriptResult: true,
      ok: true,
      value: {
        url: 'https://stale.test',
        get refs() {
          staleRefsRead = true
          return []
        },
        pageText: { headings: [], snippets: [] }
      }
    })
    contents[0]!.emit('destroyed')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await service.getUrl(input), 'https://example.test')
    assert.equal(contents[1]!.closed, 0)
    assert.equal(staleRefsRead, false)
  } finally {
    service.dispose()
  }
})

test('renderer crash rejects active operation and removes session immediately', async () => {
  const { service, contents } = setup(1000)
  try {
    await service.open(input)
    const pending = service.snapshot(input)
    const rejected = assert.rejects(pending, /crashed/)
    await Promise.resolve()
    contents[0]!.emit('render-process-gone', {}, { reason: 'crashed' })
    await rejected
    assert.equal(contents[0]!.closed, 1)
    assert.deepEqual(service.listSessions(input), [])
  } finally {
    service.dispose()
  }
})

test('browser RPC abort destroys the underlying main session', async () => {
  const { service, contents } = setup(1000)
  const [mainTransport, utilityTransport] = createLoopbackTransportPair()
  serveRpcTarget({ transport: mainTransport, target: createBrowserAutomationRpcTarget(service) })
  const remote = createRpcBrowserAutomationBackend(createRpcClient(utilityTransport))
  try {
    await remote.open(input)
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    contents[0]!.executeJavaScript = () => {
      started()
      return new Promise(() => {})
    }
    const controller = new AbortController()
    const pending = remote.snapshot({ ...input, signal: controller.signal })
    const rejected = assert.rejects(pending, /abort/i)
    await ready
    controller.abort()
    await rejected
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(contents[0]!.closed, 1)
    assert.deepEqual(service.listSessions(input), [])
  } finally {
    service.dispose()
  }
})

test('dispose cancels pending proxy setup; late completion cannot create a view', async () => {
  let release!: () => void
  const proxy = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service, contents } = setup(1000, proxy)
  const pending = service.open(input)
  const rejected = assert.rejects(pending, /disposed/)
  await Promise.resolve()
  service.dispose()
  await rejected
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(contents.length, 0)
  await assert.rejects(service.open(input), /disposed/)
})

test('explicit wait timeout is not shortened by default operation deadline and keeps healthy session', async () => {
  const { service, contents } = setup(10)
  try {
    await service.open(input)
    contents[0]!.executeJavaScript = async () => ({
      __yachiyoBrowserAutomationScriptResult: true,
      ok: true,
      value: false
    })
    await assert.rejects(
      service.waitForFunction({ ...input, predicate: 'false', timeoutMs: 30, pollIntervalMs: 1 }),
      /waiting for predicate/
    )
    assert.equal(contents[0]!.closed, 0)
  } finally {
    service.dispose()
  }
})

test('explicit eval timeout destroys a renderer that never completes', async () => {
  const { service, contents } = setup(1000)
  try {
    await service.open(input)
    await assert.rejects(
      service.evaluateScript({ ...input, script: 'await new Promise(() => {})', timeoutMs: 10 }),
      /Timed out after 1010ms/
    )
    assert.equal(contents[0]!.closed, 1)
  } finally {
    service.dispose()
  }
})

test('late eval resolution after deadline cannot update replacement session', async () => {
  const { service, contents } = setup(1000)
  try {
    await service.open(input)
    let release!: (value: unknown) => void
    contents[0]!.executeJavaScript = () =>
      new Promise((resolve) => {
        release = resolve
      })
    await assert.rejects(
      service.evaluateScript({ ...input, script: 'await delayed()', timeoutMs: 10 }),
      /Timed out/
    )
    await service.open(input)
    release({ __yachiyoBrowserAutomationScriptResult: true, ok: true, value: 'stale result' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await service.getUrl(input), 'https://example.test')
    assert.equal(contents[0]!.closed, 1)
    assert.equal(contents[1]!.closed, 0)
  } finally {
    service.dispose()
  }
})

test('snapshot waits for same-session navigation to finish', async () => {
  const { service, contents } = setup(1000)
  try {
    await service.open(input)
    let release!: () => void
    let evaluated = false
    contents[0]!.loadURL = () =>
      new Promise((resolve) => {
        release = resolve
      })
    contents[0]!.executeJavaScript = async () => {
      evaluated = true
      return {
        __yachiyoBrowserAutomationScriptResult: true,
        ok: true,
        value: { url: 'https://example.test', refs: [], pageText: { headings: [], snippets: [] } }
      }
    }
    const navigation = service.loadUrl({ ...input, url: 'https://example.test' })
    const snapshot = service.snapshot(input)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(evaluated, false)
    release()
    await navigation
    await snapshot
    assert.equal(evaluated, true)
  } finally {
    service.dispose()
  }
})

test('short eval timeout still allows successful script interaction settlement', async () => {
  const { service, contents } = setup(10)
  try {
    await service.open(input)
    contents[0]!.executeJavaScript = async () => ({
      __yachiyoBrowserAutomationScriptResult: true,
      ok: true,
      value: 42
    })
    const result = await service.evaluateScript({ ...input, script: 'return 42', timeoutMs: 100 })
    assert.equal(result.value, 42)
    assert.equal(contents[0]!.closed, 0)
  } finally {
    service.dispose()
  }
})

test('pre-aborted open creates no view', async () => {
  const { service, contents } = setup()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(service.open({ ...input, signal: controller.signal }), {
      name: 'AbortError'
    })
    assert.equal(contents.length, 0)
  } finally {
    service.dispose()
  }
})

test('destroyed contents invalidate the generation even before destroyed event delivery', async () => {
  const { service, contents } = setup()
  try {
    await service.open(input)
    contents[0]!.destroyed = true
    await assert.rejects(service.open(input), /destroyed/)
    assert.equal(contents.length, 1)
    await service.open(input)
    contents[0]!.emit('destroyed')
    assert.equal(contents.length, 2)
    assert.equal(service.listSessions(input).length, 1)
  } finally {
    service.dispose()
  }
})
