export interface BeforeQuitEventLike {
  preventDefault(): void
}

export interface AppQuitTarget {
  onBeforeQuit(listener: (event: BeforeQuitEventLike) => void): void
  quit(): void
}

export function deferAppQuitUntil(input: {
  app: AppQuitTarget
  cleanup: () => Promise<void>
  onCleanupError: (error: unknown) => void
}): void {
  let state: 'idle' | 'running' | 'done' = 'idle'

  input.app.onBeforeQuit((event) => {
    if (state === 'done') return

    event.preventDefault()
    if (state === 'running') return
    state = 'running'

    void (async () => {
      try {
        await input.cleanup()
      } catch (error) {
        input.onCleanupError(error)
      } finally {
        state = 'done'
        input.app.quit()
      }
    })()
  })
}
