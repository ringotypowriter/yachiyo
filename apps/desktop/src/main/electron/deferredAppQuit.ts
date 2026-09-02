export interface BeforeQuitEventLike {
  preventDefault(): void
}

export interface AppQuitTarget {
  onBeforeQuit(listener: (event: BeforeQuitEventLike) => void): void
  quit(): void
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000

export function deferAppQuitUntil(input: {
  app: AppQuitTarget
  cleanup: () => Promise<void>
  cleanupTimeoutMs?: number
  onCleanupError: (error: unknown) => void
}): void {
  let state: 'idle' | 'running' | 'done' = 'idle'

  input.app.onBeforeQuit((event) => {
    if (state === 'done') return

    event.preventDefault()
    if (state === 'running') return
    state = 'running'

    void (async () => {
      let timeout: NodeJS.Timeout | undefined
      try {
        const cleanupTimeoutMs = input.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
        await Promise.race([
          input.cleanup(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`App cleanup timed out after ${cleanupTimeoutMs} ms.`)),
              cleanupTimeoutMs
            )
          })
        ])
      } catch (error) {
        input.onCleanupError(error)
      } finally {
        if (timeout) clearTimeout(timeout)
        state = 'done'
        input.app.quit()
      }
    })()
  })
}
