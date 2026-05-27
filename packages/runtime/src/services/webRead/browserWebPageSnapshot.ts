import type { BrowserSearchSession } from '../webSearch/browserSearchSession.ts'
import { runWithBrowserRetries } from '../webSearch/browserRetry.ts'

const DEFAULT_BROWSER_WEB_READ_TIMEOUT_MS = 15_000
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') {
      return false
    }

    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const bodyText = normalizeText(document.body?.innerText)
    const articleText = normalizeText(document.querySelector('article')?.innerText)
    const mainText = normalizeText(document.querySelector('main, [role="main"]')?.innerText)

    return articleText.length >= 120 || mainText.length >= 200 || bodyText.length >= 400
  })()
`
const SNAPSHOT_SCRIPT = `
  (() => ({
    contentType: document.contentType || 'text/html',
    html: document.documentElement?.outerHTML || '',
    title: document.title || ''
  }))()
`

export interface BrowserWebPageSnapshot {
  contentType?: string
  finalUrl: string
  html: string
}

export type BrowserWebPageSnapshotLoader = (input: {
  signal?: AbortSignal
  url: string
}) => Promise<BrowserWebPageSnapshot>

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function createBrowserWebPageSnapshotLoader(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): BrowserWebPageSnapshotLoader {
  const loadTimeoutMs = input.loadTimeoutMs ?? DEFAULT_BROWSER_WEB_READ_TIMEOUT_MS
  const retryAttempts = input.retryAttempts ?? 3
  const retryDelayMs = input.retryDelayMs ?? 350

  return async ({ signal, url }) =>
    runWithBrowserRetries({
      attempts: retryAttempts,
      delayMs: retryDelayMs,
      signal,
      run: async () =>
        input.browserSession.withPage(async (page) => {
          await page.loadURL(url)

          try {
            await page.waitForFunction({
              predicate: PAGE_READY_PREDICATE,
              timeoutMs: loadTimeoutMs,
              signal
            })
          } catch (error) {
            if (isAbortError(error)) {
              throw error
            }
          }

          const snapshot = await page.evaluate<{
            contentType?: string
            html: string
            title?: string
          }>(SNAPSHOT_SCRIPT)

          if (!snapshot.html.trim()) {
            throw new Error('Browser snapshot returned empty HTML.')
          }

          return {
            finalUrl: page.getURL() || url,
            ...(snapshot.contentType ? { contentType: snapshot.contentType } : {}),
            html: snapshot.html
          }
        })
    })
}
