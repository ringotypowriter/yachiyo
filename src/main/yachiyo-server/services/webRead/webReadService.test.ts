import assert from 'node:assert/strict'
import test from 'node:test'

import { readWebPage } from './webReadService.ts'

function createHtmlResponse(
  body: string,
  options: {
    contentType?: string
    status?: number
    url?: string
  } = {}
): Response {
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: options.contentType ? { 'content-type': options.contentType } : undefined
  })

  Object.defineProperty(response, 'url', {
    configurable: true,
    value: options.url ?? 'https://example.com/final-article'
  })

  return response
}

test('readWebPage extracts readable markdown from a static article and keeps redirect metadata', async () => {
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <title>Example article</title>
      <meta name="author" content="A. Writer" />
      <meta name="description" content="A short summary." />
      <meta property="og:site_name" content="Example Site" />
      <meta property="article:published_time" content="2026-03-20T12:00:00.000Z" />
    </head>
    <body>
      <header>Header promo</header>
      <nav>Site navigation</nav>
      <article>
        <h1>Example article</h1>
        <p>First paragraph.</p>
        <p>Second paragraph.</p>
      </article>
      <footer>Footer links</footer>
    </body>
  </html>`

  const result = await readWebPage(
    {
      url: 'https://example.com/article'
    },
    {
      fetchImpl: async () =>
        createHtmlResponse(html, {
          contentType: 'text/html; charset=utf-8',
          url: 'https://example.com/final-article'
        })
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.extractor, 'defuddle')
  assert.equal(result.requestedUrl, 'https://example.com/article')
  assert.equal(result.finalUrl, 'https://example.com/final-article')
  assert.equal(result.httpStatus, 200)
  assert.equal(result.contentType, 'text/html; charset=utf-8')
  assert.equal(result.contentFormat, 'markdown')
  assert.equal(result.title, 'Example article')
  assert.equal(result.author, 'A. Writer')
  assert.equal(result.siteName, 'Example Site')
  assert.equal(result.publishedTime, '2026-03-20T12:00:00.000Z')
  assert.equal(result.description, 'A short summary.')
  assert.match(result.content, /First paragraph\./)
  assert.match(result.content, /Second paragraph\./)
  assert.doesNotMatch(result.content, /Site navigation/)
  assert.doesNotMatch(result.content, /Footer links/)
})

test('readWebPage sends browser-like document request headers', async () => {
  let requestHeaders: Headers | undefined

  await readWebPage(
    {
      url: 'https://example.com/article'
    },
    {
      fetchImpl: async (_url, init) => {
        requestHeaders = new Headers(init?.headers)

        return createHtmlResponse('<html><body><article>ok</article></body></html>', {
          contentType: 'text/html; charset=utf-8'
        })
      }
    }
  )

  assert.equal(
    requestHeaders?.get('accept'),
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
  )
  assert.equal(requestHeaders?.get('accept-language'), 'en-US,en;q=0.9')
  assert.equal(requestHeaders?.get('cache-control'), 'no-cache')
  assert.equal(requestHeaders?.get('pragma'), 'no-cache')
  assert.equal(requestHeaders?.get('sec-fetch-dest'), 'document')
  assert.equal(requestHeaders?.get('sec-fetch-mode'), 'navigate')
  assert.equal(requestHeaders?.get('sec-fetch-site'), 'none')
  assert.equal(requestHeaders?.get('sec-fetch-user'), '?1')
  assert.equal(requestHeaders?.get('upgrade-insecure-requests'), '1')
  assert.match(requestHeaders?.get('user-agent') ?? '', /Mozilla\/5\.0/)
})

test('readWebPage rejects invalid URLs before issuing a fetch', async () => {
  let fetchCalls = 0

  const result = await readWebPage(
    {
      url: 'notaurl'
    },
    {
      fetchImpl: async () => {
        fetchCalls += 1
        return createHtmlResponse('<html></html>')
      }
    }
  )

  assert.equal(fetchCalls, 0)
  assert.equal(result.error, 'Invalid URL. Use a full http:// or https:// URL.')
  assert.equal(result.failureCode, 'invalid-url')
  assert.equal(result.extractor, 'none')
  assert.equal(result.content, '')
})

test('readWebPage maps network failures into structured errors', async () => {
  const result = await readWebPage(
    {
      url: 'https://example.com/article'
    },
    {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443')
      }
    }
  )

  assert.match(result.error ?? '', /Failed to fetch https:\/\/example\.com\/article/)
  assert.equal(result.failureCode, 'fetch-failed')
  assert.equal(result.extractor, 'none')
})

test('readWebPage falls back to a browser snapshot for X URLs when the static fetch fails', async () => {
  let browserSnapshotCalls = 0

  const result = await readWebPage(
    {
      url: 'https://x.com/HiTw93/article/2034627967926825175'
    },
    {
      fetchImpl: async () => {
        throw new Error('blocked by upstream')
      },
      loadBrowserSnapshot: async ({ url }) => {
        browserSnapshotCalls += 1
        assert.equal(url, 'https://x.com/HiTw93/article/2034627967926825175')

        return {
          finalUrl: url,
          contentType: 'text/html; charset=utf-8',
          html: `<!doctype html>
            <html>
              <head>
                <title>X article</title>
              </head>
              <body>
                <article>
                  <h1>X article</h1>
                  <p>Loaded from the live browser DOM.</p>
                </article>
              </body>
            </html>`
        }
      },
      extractReadableContent: async (document) => {
        const htmlDocument = document as Document

        return {
          extractor: 'defuddle',
          title: htmlDocument.querySelector('h1')?.textContent?.trim() ?? 'Untitled',
          content: htmlDocument.querySelector('article')?.textContent?.trim() ?? ''
        }
      }
    }
  )

  assert.equal(browserSnapshotCalls, 1)
  assert.equal(result.error, undefined)
  assert.equal(result.failureCode, undefined)
  assert.equal(result.extractor, 'defuddle')
  assert.equal(result.title, 'X article')
  assert.match(result.content, /Loaded from the live browser DOM\./)
})

test('readWebPage rejects unsupported non-HTML content', async () => {
  const result = await readWebPage(
    {
      url: 'https://example.com/data'
    },
    {
      fetchImpl: async () =>
        createHtmlResponse('{"ok":true}', {
          contentType: 'application/json',
          url: 'https://example.com/data'
        })
    }
  )

  assert.equal(
    result.error,
    'Unsupported content type: application/json. webRead only supports static HTML pages.'
  )
  assert.equal(result.failureCode, 'unsupported-content-type')
  assert.equal(result.httpStatus, 200)
  assert.equal(result.contentType, 'application/json')
})

test('readWebPage falls back to bounded linkedom extraction when the primary extractor fails', async () => {
  const html = `<!doctype html>
  <html>
    <head>
      <title>Fallback article</title>
    </head>
    <body>
      <nav>Ignore me</nav>
      <main>
        <h1>Fallback article</h1>
        <p>Useful fallback text.</p>
      </main>
    </body>
  </html>`

  const result = await readWebPage(
    {
      url: 'https://example.com/fallback'
    },
    {
      fetchImpl: async () => createHtmlResponse(html, { contentType: 'text/html' }),
      extractReadableContent: async () => {
        throw new Error('defuddle crashed')
      }
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.extractor, 'linkedom-fallback')
  assert.equal(result.title, 'Fallback article')
  assert.match(result.content, /Useful fallback text\./)
  assert.doesNotMatch(result.content, /Ignore me/)
})

test('readWebPage retries X shell pages through the browser when static extraction is empty', async () => {
  let browserSnapshotCalls = 0

  const result = await readWebPage(
    {
      url: 'https://x.com/HiTw93/article/2034627967926825175'
    },
    {
      fetchImpl: async () =>
        createHtmlResponse(
          '<!doctype html><html><head><title>X</title></head><body><div id="react-root"></div></body></html>',
          {
            contentType: 'text/html; charset=utf-8',
            url: 'https://x.com/HiTw93/article/2034627967926825175'
          }
        ),
      loadBrowserSnapshot: async ({ url }) => {
        browserSnapshotCalls += 1

        return {
          finalUrl: url,
          contentType: 'text/html; charset=utf-8',
          html: `<!doctype html>
            <html>
              <head>
                <title>X article</title>
              </head>
              <body>
                <article>
                  <h1>X article</h1>
                  <p>Recovered after loading the live page.</p>
                </article>
              </body>
            </html>`
        }
      },
      extractReadableContent: async (document) => {
        const htmlDocument = document as Document

        return {
          extractor: 'defuddle',
          title: htmlDocument.querySelector('h1')?.textContent?.trim() ?? 'X',
          content: htmlDocument.querySelector('article')?.textContent?.trim() ?? ''
        }
      }
    }
  )

  assert.equal(browserSnapshotCalls, 1)
  assert.equal(result.error, undefined)
  assert.equal(result.failureCode, undefined)
  assert.equal(result.extractor, 'defuddle')
  assert.equal(result.title, 'X article')
  assert.match(result.content, /Recovered after loading the live page\./)
})

test('readWebPage truncates oversized extracted content and reports the original size', async () => {
  const longContent = Array.from({ length: 12_000 }, () => 'word').join(' ')

  const result = await readWebPage(
    {
      url: 'https://example.com/long'
    },
    {
      fetchImpl: async () =>
        createHtmlResponse('<html><body><article>stub</article></body></html>', {
          contentType: 'text/html; charset=utf-8'
        }),
      extractReadableContent: async () => ({
        extractor: 'defuddle',
        title: 'Long article',
        content: longContent
      })
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.extractor, 'defuddle')
  assert.equal(result.truncated, true)
  assert.equal(result.originalContentChars, longContent.length)
  assert.ok(result.contentChars < longContent.length)
  assert.equal(result.content.length, result.contentChars)
})

test('readWebPage classifies body-read aborts as timeouts', async () => {
  const aborted = new Error('aborted')
  aborted.name = 'AbortError'

  const result = await readWebPage(
    {
      url: 'https://example.com/slow'
    },
    {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw aborted
            }
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8'
            }
          }
        )
    }
  )

  assert.equal(result.failureCode, 'timeout')
  assert.equal(result.error, 'Timed out while reading response body from https://example.com/slow.')
})

test('readWebPage accepts HTML responses larger than 1 MB', async () => {
  const largeArticle = `<html><body><article>${'a'.repeat(1_500_000)}</article></body></html>`

  const result = await readWebPage(
    {
      url: 'https://example.com/large'
    },
    {
      fetchImpl: async () =>
        createHtmlResponse(largeArticle, {
          contentType: 'text/html; charset=utf-8'
        }),
      extractReadableContent: async () => ({
        extractor: 'defuddle',
        title: 'Large article',
        content: 'Large content'
      })
    }
  )

  assert.equal(result.failureCode, undefined)
  assert.equal(result.error, undefined)
  assert.equal(result.title, 'Large article')
  assert.equal(result.extractor, 'defuddle')
})
