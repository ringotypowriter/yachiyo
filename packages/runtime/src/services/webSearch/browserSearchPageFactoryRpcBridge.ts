import type { RpcClient } from '@yachiyo/shared/rpc/rpcClient'

import type { BrowserSearchPage, BrowserSearchPageFactory } from './browserSearchSession.ts'

/**
 * Bridges BrowserSearchPageFactory across the RPC boundary. The main process
 * serves the live Electron-backed factory and keeps a page registry keyed by
 * id; the runtime host (utility process) gets proxy pages that forward
 * evaluate/getURL/loadURL. waitForFunction is NOT forwarded: the proxy polls
 * the remote predicate locally (mirroring the Electron implementation), so
 * AbortSignal support stays fully on the caller's side of the boundary.
 */
const RPC_METHOD_PREFIX = 'browserSearchPage.'

const DEFAULT_WAIT_POLL_INTERVAL_MS = 100

export function createBrowserSearchPageFactoryRpcTarget(
  factory: BrowserSearchPageFactory
): Record<string, (input: never) => unknown> {
  const pagesById = new Map<number, BrowserSearchPage>()
  let nextPageId = 1

  function requirePage(pageId: number): BrowserSearchPage {
    const page = pagesById.get(pageId)
    if (!page) {
      throw new Error(`Unknown browser search page: ${pageId}`)
    }
    return page
  }

  return {
    [`${RPC_METHOD_PREFIX}create`]: async (input: { profilePath: string }) => {
      const page = await factory.createPage(input.profilePath)
      const pageId = nextPageId++
      pagesById.set(pageId, page)
      return { pageId }
    },
    [`${RPC_METHOD_PREFIX}dispose`]: async (input: { pageId: number }) => {
      const page = requirePage(input.pageId)
      pagesById.delete(input.pageId)
      await factory.disposePage(page)
    },
    [`${RPC_METHOD_PREFIX}evaluate`]: (input: { pageId: number; script: string }) =>
      requirePage(input.pageId).evaluate(input.script),
    [`${RPC_METHOD_PREFIX}getUrl`]: (input: { pageId: number }) =>
      requirePage(input.pageId).getURL(),
    [`${RPC_METHOD_PREFIX}loadUrl`]: (input: { pageId: number; url: string }) =>
      requirePage(input.pageId).loadURL(input.url)
  }
}

export function createRpcBrowserSearchPageFactory(
  client: Pick<RpcClient, 'call'>
): BrowserSearchPageFactory {
  const pageIds = new WeakMap<BrowserSearchPage, number>()

  function createProxyPage(pageId: number): BrowserSearchPage {
    const evaluate = async <TResult>(script: string): Promise<TResult> =>
      (await client.call(`${RPC_METHOD_PREFIX}evaluate`, [{ pageId, script }])) as TResult

    return {
      evaluate,
      getURL: async () => (await client.call(`${RPC_METHOD_PREFIX}getUrl`, [{ pageId }])) as string,
      loadURL: async (url) => {
        await client.call(`${RPC_METHOD_PREFIX}loadUrl`, [{ pageId, url }])
      },
      waitForFunction: async (input) => {
        const start = Date.now()
        const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS

        while (Date.now() - start < input.timeoutMs) {
          if (input.signal?.aborted) {
            const error = new Error('Aborted')
            error.name = 'AbortError'
            throw error
          }

          const matched = await evaluate<boolean>(input.predicate)
          if (matched) {
            return
          }

          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
        }

        throw new Error(`Timed out after ${input.timeoutMs}ms waiting for page readiness.`)
      }
    }
  }

  return {
    createPage: async (profilePath) => {
      const created = (await client.call(`${RPC_METHOD_PREFIX}create`, [{ profilePath }])) as {
        pageId: number
      }
      const page = createProxyPage(created.pageId)
      pageIds.set(page, created.pageId)
      return page
    },
    disposePage: async (page) => {
      const pageId = pageIds.get(page)
      if (pageId === undefined) {
        throw new Error('Browser search page was not created by this factory')
      }
      pageIds.delete(page)
      await client.call(`${RPC_METHOD_PREFIX}dispose`, [{ pageId }])
    }
  }
}
