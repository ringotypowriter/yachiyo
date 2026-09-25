import type { RpcClient } from '@yachiyo/shared/rpc/rpcClient'

/**
 * Bridges the cert-relaxed web-external fetch across the RPC boundary. The
 * session that relaxes TLS for SSL-intercepting proxies only exists in the
 * Electron main process, so the runtime host forwards requests there; the
 * response streams back through the RPC progress channel (head first, then
 * body chunks), which preserves real streaming semantics for every consumer —
 * webRead's size cap, jsRepl's worker streams, image downloads.
 */
const FETCH_METHOD = 'mainHost.webExternalFetch'
const ABORT_METHOD = 'mainHost.webExternalFetchAbort'

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

interface BridgedFetchRequest {
  fetchId: number
  url: string
  method?: string
  headers?: Array<[string, string]>
  redirect?: RequestRedirect
  bodyText?: string
  bodyBytes?: Uint8Array
}

interface BridgedFetchHead {
  kind: 'head'
  url: string
  status: number
  statusText: string
  headers: Array<[string, string]>
}

interface BridgedFetchChunk {
  kind: 'chunk'
  bytes: Uint8Array
}

type BridgedFetchProgress = BridgedFetchHead | BridgedFetchChunk

export function createWebExternalFetchRpcTarget(
  fetchImpl: typeof globalThis.fetch
): Record<string, (input: never, emitProgress?: (value: unknown) => void) => unknown> {
  const abortControllers = new Map<number, AbortController>()

  return {
    [FETCH_METHOD]: async (
      input: BridgedFetchRequest,
      emitProgress?: (value: unknown) => void
    ): Promise<void> => {
      if (!emitProgress) {
        throw new Error('webExternalFetch must be called with a progress channel')
      }
      const controller = new AbortController()
      abortControllers.set(input.fetchId, controller)
      let rejectAbort!: (error: Error) => void
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject
      })
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const onAbort = (): void => {
        void reader?.cancel().catch(() => undefined)
        rejectAbort(new DOMException('The operation was aborted.', 'AbortError'))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const fetchPromise = fetchImpl(input.url, {
          ...(input.method ? { method: input.method } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.redirect ? { redirect: input.redirect } : {}),
          // Uint8Array is a valid fetch body at runtime; lib.dom's BodyInit
          // only rejects it over the ArrayBufferLike generic parameter.
          ...(input.bodyBytes !== undefined
            ? { body: input.bodyBytes as unknown as BodyInit }
            : input.bodyText !== undefined
              ? { body: input.bodyText }
              : {}),
          signal: controller.signal
        })
        void fetchPromise
          .then((response) => {
            if (controller.signal.aborted && !response.body?.locked) {
              void response.body?.cancel().catch(() => undefined)
            }
          })
          .catch(() => undefined)
        const response = await Promise.race([fetchPromise, aborted])
        if (controller.signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        emitProgress({
          kind: 'head',
          url: response.url || input.url,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()]
        } satisfies BridgedFetchHead)

        reader = response.body?.getReader()
        if (!reader) {
          return
        }
        for (;;) {
          if (controller.signal.aborted) {
            void reader.cancel().catch(() => undefined)
            return
          }
          const { done, value } = await Promise.race([reader.read(), aborted])
          if (controller.signal.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError')
          }
          if (done) {
            return
          }
          emitProgress({ kind: 'chunk', bytes: value } satisfies BridgedFetchChunk)
        }
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
        abortControllers.delete(input.fetchId)
      }
    },
    [ABORT_METHOD]: (input: { fetchId: number }): void => {
      abortControllers.get(input.fetchId)?.abort()
    }
  }
}

function normalizeBridgedBody(
  body: BodyInit | null | undefined
): Pick<BridgedFetchRequest, 'bodyText' | 'bodyBytes'> {
  if (body === undefined || body === null) {
    return {}
  }
  if (typeof body === 'string') {
    return { bodyText: body }
  }
  if (body instanceof URLSearchParams) {
    return { bodyText: body.toString() }
  }
  if (body instanceof Uint8Array) {
    return { bodyBytes: body }
  }
  if (body instanceof ArrayBuffer) {
    return { bodyBytes: new Uint8Array(body) }
  }
  throw new Error('This request body cannot cross the RPC boundary; send a string or bytes')
}

export function createRpcWebExternalFetch(
  client: Pick<RpcClient, 'call'>
): typeof globalThis.fetch {
  let nextFetchId = 1

  return async (input, init) => {
    if (init?.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new DOMException('The operation was aborted.', 'AbortError')
    }
    if (input instanceof Request && input.body) {
      throw new Error('A streaming request body cannot cross the RPC boundary')
    }
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const fetchId = nextFetchId++
    const request: BridgedFetchRequest = {
      fetchId,
      url,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.headers ? { headers: [...new Headers(init.headers).entries()] } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
      ...normalizeBridgedBody(init?.body)
    }

    let resolveHead!: (head: BridgedFetchHead) => void
    let rejectHead!: (error: Error) => void
    const headPromise = new Promise<BridgedFetchHead>((resolve, reject) => {
      resolveHead = resolve
      rejectHead = reject
    })

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let consumerCancelled = false
    let streamSettled = false
    const requestAbort = (): void => {
      void client.call(ABORT_METHOD, [{ fetchId }]).catch(() => {
        // The fetch may already be settled on the main side; nothing to abort.
      })
    }
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        consumerCancelled = true
        init?.signal?.removeEventListener('abort', onAbort)
        requestAbort()
      }
    })

    const onAbort = (): void => {
      const error =
        init?.signal?.reason instanceof Error
          ? init.signal.reason
          : new DOMException('The operation was aborted.', 'AbortError')
      consumerCancelled = true
      rejectHead(error)
      if (!streamSettled) {
        streamSettled = true
        streamController?.error(error)
      }
      requestAbort()
    }

    const callPromise = client.call(FETCH_METHOD, [request], {
      onProgress: (value) => {
        const event = value as BridgedFetchProgress
        if (event.kind === 'head') {
          if (!consumerCancelled) resolveHead(event)
          return
        }
        if (!consumerCancelled) {
          streamController?.enqueue(event.bytes)
        }
      }
    })
    callPromise.then(
      () => {
        init?.signal?.removeEventListener('abort', onAbort)
        if (!consumerCancelled && !streamSettled) {
          streamSettled = true
          streamController?.close()
        }
      },
      (error: unknown) => {
        init?.signal?.removeEventListener('abort', onAbort)
        const failure = error instanceof Error ? error : new Error(String(error))
        rejectHead(failure)
        if (!consumerCancelled && !streamSettled) {
          streamSettled = true
          streamController?.error(failure)
        }
      }
    )

    if (init?.signal) {
      init.signal.addEventListener('abort', onAbort, { once: true })
      if (init.signal.aborted) onAbort()
    }

    const head = await headPromise
    const response = new Response(NULL_BODY_STATUSES.has(head.status) ? null : bodyStream, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers
    })
    // Response.url is a read-only getter; shadow it so consumers see the
    // final post-redirect url exactly like an in-process fetch.
    Object.defineProperty(response, 'url', { value: head.url })
    return response
  }
}
