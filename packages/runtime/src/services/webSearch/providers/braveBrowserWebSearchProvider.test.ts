import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { parseHTML } from 'linkedom'

import { BrowserSearchSession } from '../browserSearchSession.ts'
import { createBraveBrowserWebSearchProvider } from './braveBrowserWebSearchProvider.ts'

function createDomSession(html: string, onLoad?: (url: string) => void): BrowserSearchSession {
  const { document } = parseHTML(html)
  Object.defineProperty(document, 'readyState', { value: 'complete' })

  return new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        return {
          async loadURL(url) {
            onLoad?.(url)
          },
          async waitForFunction({ predicate }) {
            assert.equal(runInNewContext(predicate, { document }), true)
          },
          async evaluate<TResult>(script: string) {
            return runInNewContext(script, { document }) as TResult
          },
          async getURL() {
            return 'https://search.brave.com/search?q=yachiyo&source=web'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })
}

test('Brave provider extracts the current snippet result structure', async () => {
  let loadedUrl = ''
  const session = createDomSession(
    `
      <html><body>
        <div class="snippet standalone"><div class="search-snippet-title">AI summary</div></div>
        <div class="snippet fdb">
          <div class="result-content"><a href="https://example.com/first"></a></div>
          <div class="search-snippet-title"> First result </div>
          <div class="generic-snippet"><div class="content"> First snippet </div></div>
        </div>
        <div class="snippet fdb">
          <div class="result-content"><a href="https://example.org/second"></a></div>
          <div class="search-snippet-title">Second result</div>
        </div>
      </body></html>
    `,
    (url) => {
      loadedUrl = url
    }
  )
  const provider = createBraveBrowserWebSearchProvider({ browserSession: session })

  const result = await provider.search({ query: 'yachiyo electron', limit: 2 })

  const requestUrl = new URL(loadedUrl)
  assert.equal(requestUrl.origin + requestUrl.pathname, 'https://search.brave.com/search')
  assert.equal(requestUrl.searchParams.get('q'), 'yachiyo electron')
  assert.equal(requestUrl.searchParams.get('source'), 'web')
  assert.deepEqual(result.results, [
    {
      rank: 1,
      title: 'First result',
      url: 'https://example.com/first',
      snippet: 'First snippet'
    },
    { rank: 2, title: 'Second result', url: 'https://example.org/second' }
  ])
})

test('Brave provider recognizes the verified proof-of-work challenge without retrying', async () => {
  let attempts = 0
  const session = createDomSession(`
    <html><body>
      <a href="/help/pow-captcha">Why am I seeing this?</a>
      <button>Verify</button>
    </body></html>
  `)
  const originalWithPage = session.withPage.bind(session)
  session.withPage = async (task) => {
    attempts += 1
    return originalWithPage(task)
  }
  const provider = createBraveBrowserWebSearchProvider({
    browserSession: session,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(attempts, 1)
  assert.equal(result.failureCode, 'provider-failed')
  assert.match(result.error ?? '', /challenge/i)
})
