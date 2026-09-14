import { AsyncLocalStorage } from 'node:async_hooks'

type SessionKey = { threadId: string; session: string }
type OperationInput = SessionKey & { signal?: AbortSignal; timeoutMs?: number }
type Generation = { input: SessionKey; tail: Promise<unknown>; controller: AbortController }

/** Session-scoped deadlines and isolation, independent of Electron and RPC. */
export function createBrowserOperationLifecycle(
  destroy: (input: SessionKey) => void,
  defaultTimeoutMs = 30_000
): {
  run<T>(input: OperationInput, operation: () => Promise<T>): Promise<T>
  invalidate(input: SessionKey, error: Error): void
  assertCurrent(): void
  dispose(): void
} {
  let disposed = false
  const generations = new Map<string, Generation>()
  const context = new AsyncLocalStorage<Generation>()
  const keyOf = (input: SessionKey): string => JSON.stringify([input.threadId, input.session])

  function invalidate(input: SessionKey, error: Error): void {
    const key = keyOf(input)
    const generation = generations.get(key)
    if (!generation) return
    generations.delete(key)
    generation.controller.abort(error)
    destroy(input)
  }

  function assertCurrent(): void {
    context.getStore()?.controller.signal.throwIfAborted()
  }

  async function run<T>(input: OperationInput, operation: () => Promise<T>): Promise<T> {
    if (disposed) throw new Error('Browser automation service is disposed')
    input.signal?.throwIfAborted()
    const key = keyOf(input)
    let generation = generations.get(key)
    if (!generation) {
      generation = {
        input: { threadId: input.threadId, session: input.session },
        tail: Promise.resolve(),
        controller: new AbortController()
      }
      generations.set(key, generation)
    }
    const current = generation
    const signal = current.controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectInterrupted!: (reason: unknown) => void
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterrupted = reject
    })
    const onInvalidated = (): void => rejectInterrupted(signal.reason)
    const onAbort = (): void =>
      invalidate(input, new DOMException('Browser operation aborted', 'AbortError'))
    signal.addEventListener('abort', onInvalidated, { once: true })
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const execution = current.tail.then(() =>
      context.run(current, async () => {
        assertCurrent()
        const timeoutMs =
          typeof input.timeoutMs === 'number' &&
          Number.isFinite(input.timeoutMs) &&
          input.timeoutMs > 0
            ? input.timeoutMs
            : defaultTimeoutMs
        timer = setTimeout(
          () =>
            invalidate(
              input,
              new Error(
                `Timed out after ${timeoutMs}ms running browser operation; session invalidated. Re-open the session.`
              )
            ),
          timeoutMs
        )
        const value = await operation()
        assertCurrent()
        return value
      })
    )
    const result = Promise.race([execution, interrupted])
    current.tail = result.catch(() => {})
    try {
      return await result
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onInvalidated)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  function dispose(): void {
    disposed = true
    for (const generation of generations.values()) {
      invalidate(generation.input, new Error('Browser automation service disposed'))
    }
  }

  return { run, invalidate, assertCurrent, dispose }
}
