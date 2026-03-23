import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserSearchSession } from '../webSearch/browserSearchSession.ts'
import { createBrowserWebPageSnapshotLoader } from './browserWebPageSnapshot.ts'

test('browser page snapshot loader retries transient browser load failures', async () => {
  let attempts = 0
  let disposed = 0

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-browser-page-snapshot-profile',
    pageFactory: {
      async createPage() {
        attempts += 1

        return {
          async loadURL() {
            if (attempts < 3) {
              throw new Error('ERR_CONNECTION_CLOSED')
            }
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            return {
              contentType: 'text/html; charset=utf-8',
              html: '<html><body><article>Recovered</article></body></html>'
            } as TResult
          },
          getURL() {
            return 'https://x.com/example/status/123'
          }
        }
      },
      async disposePage() {
        disposed += 1
      }
    }
  })

  const loadSnapshot = createBrowserWebPageSnapshotLoader({
    browserSession: session,
    loadTimeoutMs: 100,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const snapshot = await loadSnapshot({
    url: 'https://x.com/example/status/123'
  })

  assert.equal(attempts, 3)
  assert.equal(disposed, 3)
  assert.equal(snapshot.finalUrl, 'https://x.com/example/status/123')
  assert.match(snapshot.html, /Recovered/)
})

test('browser page snapshot loader retries empty DOM snapshots before succeeding', async () => {
  let attempts = 0

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-browser-page-snapshot-profile',
    pageFactory: {
      async createPage() {
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            attempts += 1

            return {
              contentType: 'text/html; charset=utf-8',
              html:
                attempts < 3 ? '' : '<html><body><article>Ready on retry</article></body></html>'
            } as TResult
          },
          getURL() {
            return 'https://x.com/example/status/123'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })

  const loadSnapshot = createBrowserWebPageSnapshotLoader({
    browserSession: session,
    loadTimeoutMs: 100,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const snapshot = await loadSnapshot({
    url: 'https://x.com/example/status/123'
  })

  assert.equal(attempts, 3)
  assert.match(snapshot.html, /Ready on retry/)
})
