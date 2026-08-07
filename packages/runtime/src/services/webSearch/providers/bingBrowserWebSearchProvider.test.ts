import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { parseHTML } from 'linkedom'

import { BrowserSearchSession } from '../browserSearchSession.ts'
import { createBingBrowserWebSearchProvider } from './bingBrowserWebSearchProvider.ts'

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
            return 'https://www.bing.com/search?q=yachiyo'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })
}

test('Bing provider extracts its verified b_algo result structure and unwraps redirect URLs', async () => {
  let loadedUrl = ''
  const target = 'https://example.com/first?from=bing'
  const wrapped = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}&ntb=1`
  const session = createDomSession(
    `
      <html><body><ol id="b_results">
        <li class="b_algo">
          <h2><a href="${wrapped}"> First result </a></h2>
          <div class="b_caption"><p> First snippet </p></div>
        </li>
        <li class="b_algo">
          <h2><a href="${target}">Duplicate</a></h2>
          <div class="b_caption"><p>Ignored</p></div>
        </li>
        <li class="b_algo">
          <h2><a href="https://example.org/second">Second result</a></h2>
        </li>
      </ol></body></html>
    `,
    (url) => {
      loadedUrl = url
    }
  )
  const provider = createBingBrowserWebSearchProvider({ browserSession: session })

  const result = await provider.search({ query: 'yachiyo electron', limit: 2 })

  const requestUrl = new URL(loadedUrl)
  assert.equal(requestUrl.origin + requestUrl.pathname, 'https://www.bing.com/search')
  assert.equal(requestUrl.searchParams.get('q'), 'yachiyo electron')
  assert.deepEqual(result.results, [
    { rank: 1, title: 'First result', url: target, snippet: 'First snippet' },
    { rank: 2, title: 'Second result', url: 'https://example.org/second' }
  ])
})

test('Bing provider treats a CAPTCHA page as a non-retryable provider failure', async () => {
  let attempts = 0
  const session = createDomSession(`
    <html><body>
      <form id="b_captcha"><div>Verify that you are not a robot</div></form>
    </body></html>
  `)
  const originalWithPage = session.withPage.bind(session)
  session.withPage = async (task) => {
    attempts += 1
    return originalWithPage(task)
  }
  const provider = createBingBrowserWebSearchProvider({
    browserSession: session,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(attempts, 1)
  assert.equal(result.failureCode, 'provider-failed')
  assert.match(result.error ?? '', /challenge/i)
})
