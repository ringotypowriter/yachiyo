import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { loadUrlSettlingReplacementNavigation } from './browserNavigationSettlement.ts'

class FakeWebContents extends EventEmitter {
  currentUrl = 'about:blank'
  destroyed = false
  load: (url: string) => Promise<void> = async () => {}

  getURL(): string {
    return this.currentUrl
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  async loadURL(url: string): Promise<void> {
    await this.load(url)
  }

  startNavigation(url: string): void {
    this.emit('did-start-navigation', {}, url, false, true, 1, 1)
  }

  commitNavigation(url: string): void {
    this.currentUrl = url
    this.emit('did-navigate', {}, url, 200, 'OK')
  }

  finishLoad(): void {
    this.emit('did-finish-load')
  }

  stopLoading(): void {
    this.emit('did-stop-loading')
  }

  failLoad(code: number, description: string, url: string): void {
    this.emit('did-fail-load', {}, code, description, url, true, 1, 1)
  }
}

const NAVIGATION_EVENTS = [
  'did-start-navigation',
  'did-navigate',
  'did-fail-load',
  'did-finish-load',
  'did-stop-loading',
  'destroyed'
] as const

function abortError(url: string): Error {
  return new Error(`ERR_ABORTED (-3) loading '${url}'`)
}

function assertNavigationListenersRemoved(webContents: FakeWebContents): void {
  for (const event of NAVIGATION_EVENTS) {
    assert.equal(webContents.listenerCount(event), 0, `${event} listener was not removed`)
  }
}

test('loadUrlSettlingReplacementNavigation returns the page-initiated replacement URL', async () => {
  const webContents = new FakeWebContents()
  const requestedUrl = 'https://www.google.com/search?q=yachiyo'
  const replacementUrl = `${requestedUrl}&sei=generated`

  webContents.load = async () => {
    webContents.startNavigation(requestedUrl)
    webContents.commitNavigation(requestedUrl)
    webContents.startNavigation(replacementUrl)
    setTimeout(() => {
      webContents.commitNavigation(replacementUrl)
      webContents.finishLoad()
    }, 0)
    throw abortError(replacementUrl)
  }

  const finalUrl = await loadUrlSettlingReplacementNavigation(webContents, requestedUrl, {
    settleTimeoutMs: 100
  })

  assert.equal(finalUrl, replacementUrl)
  assertNavigationListenersRemoved(webContents)
})

test('loadUrlSettlingReplacementNavigation accepts a committed replacement when loading stops', async () => {
  const webContents = new FakeWebContents()
  const requestedUrl = 'https://example.test/start'
  const replacementUrl = 'https://example.test/settled'

  webContents.load = async () => {
    webContents.startNavigation(requestedUrl)
    webContents.startNavigation(replacementUrl)
    setTimeout(() => {
      webContents.commitNavigation(replacementUrl)
      webContents.stopLoading()
    }, 0)
    throw abortError(replacementUrl)
  }

  const finalUrl = await loadUrlSettlingReplacementNavigation(webContents, requestedUrl, {
    settleTimeoutMs: 100
  })

  assert.equal(finalUrl, replacementUrl)
  assertNavigationListenersRemoved(webContents)
})

test('loadUrlSettlingReplacementNavigation preserves a terminal replacement failure', async () => {
  const webContents = new FakeWebContents()
  const requestedUrl = 'https://example.test/start'
  const replacementUrl = 'https://missing.example.test/final'

  webContents.load = async () => {
    webContents.startNavigation(requestedUrl)
    webContents.startNavigation(replacementUrl)
    setTimeout(() => {
      webContents.failLoad(-105, 'ERR_NAME_NOT_RESOLVED', replacementUrl)
    }, 0)
    throw abortError(replacementUrl)
  }

  await assert.rejects(
    loadUrlSettlingReplacementNavigation(webContents, requestedUrl, { settleTimeoutMs: 100 }),
    /Navigation failed for https:\/\/missing\.example\.test\/final: ERR_NAME_NOT_RESOLVED \(-105\)/
  )
  assertNavigationListenersRemoved(webContents)
})

test('loadUrlSettlingReplacementNavigation preserves failure after a replacement commits and stops', async () => {
  const webContents = new FakeWebContents()
  const requestedUrl = 'https://example.test/start'
  const replacementUrl = 'https://missing.example.test/final'

  webContents.load = async () => {
    webContents.startNavigation(requestedUrl)
    webContents.startNavigation(replacementUrl)
    setTimeout(() => {
      webContents.commitNavigation(replacementUrl)
      webContents.failLoad(-105, 'ERR_NAME_NOT_RESOLVED', replacementUrl)
      webContents.stopLoading()
    }, 0)
    throw abortError(replacementUrl)
  }

  await assert.rejects(
    loadUrlSettlingReplacementNavigation(webContents, requestedUrl, { settleTimeoutMs: 100 }),
    /Navigation failed for https:\/\/missing\.example\.test\/final: ERR_NAME_NOT_RESOLVED \(-105\)/
  )
  assertNavigationListenersRemoved(webContents)
})

test('loadUrlSettlingReplacementNavigation does not forgive an abort without a replacement', async () => {
  const webContents = new FakeWebContents()
  const requestedUrl = 'https://example.test/start'
  const error = abortError(requestedUrl)

  webContents.load = async () => {
    webContents.startNavigation(requestedUrl)
    throw error
  }

  await assert.rejects(
    loadUrlSettlingReplacementNavigation(webContents, requestedUrl, { settleTimeoutMs: 100 }),
    (received) => received === error
  )
  assertNavigationListenersRemoved(webContents)
})

test('loadUrlSettlingReplacementNavigation times out before accepting an uncommitted replacement', async () => {
  const webContents = new FakeWebContents()
  const requestedUrl = 'https://example.test/start'
  const replacementUrl = 'https://example.test/never-commits'

  webContents.load = async () => {
    webContents.startNavigation(requestedUrl)
    webContents.startNavigation(replacementUrl)
    throw abortError(replacementUrl)
  }

  await assert.rejects(
    loadUrlSettlingReplacementNavigation(webContents, requestedUrl, { settleTimeoutMs: 5 }),
    /Timed out after 5ms waiting for replacement navigation/
  )
  assertNavigationListenersRemoved(webContents)
})
