import type {
  ReleaseBrowserPreviewInput,
  ReleaseBrowserPreviewResult
} from '@yachiyo/shared/protocol'
import { useContentReaderStore } from './useContentReaderStore.ts'

export function startPreviewResourceLifecycle(input: {
  release: (input: ReleaseBrowserPreviewInput) => Promise<ReleaseBrowserPreviewResult>
  clock?: () => number
  every?: (callback: () => void) => () => void
}): () => void {
  let stopped = false
  let running = false
  let pending = false
  const sweep = (): void => {
    if (stopped) return
    if (running) {
      pending = true
      return
    }
    running = true
    void useContentReaderStore
      .getState()
      .discardIdle((input.clock ?? Date.now)(), (target) =>
        input.release({ threadId: target.threadId, session: target.session, mode: 'auto' })
      )
      .catch((error: unknown) => console.warn('Unable to reclaim browser preview', error))
      .finally(() => {
        running = false
        if (pending) {
          pending = false
          sweep()
        }
      })
  }
  const unsubscribe = useContentReaderStore.subscribe((state, previous) => {
    for (const [owner, entry] of Object.entries(previous.conversations)) {
      for (const tab of entry.tabs) {
        if (
          tab.target.kind !== 'web' ||
          state.conversations[owner]?.tabs.some((next) => next.id === tab.id)
        )
          continue
        void input
          .release({ threadId: owner, session: tab.target.session, mode: 'close' })
          .catch((error: unknown) => console.warn('Unable to close browser preview', error))
      }
    }
    const changed =
      state.threadId !== previous.threadId ||
      Object.entries(state.conversations).some(([owner, entry]) => {
        const before = previous.conversations[owner]
        return (
          !before ||
          entry.activeId !== before.activeId ||
          entry.tabs.length !== before.tabs.length ||
          entry.tabs.some(
            (tab, index) =>
              tab.hot !== before.tabs[index]?.hot ||
              tab.lastUsedAt !== before.tabs[index]?.lastUsedAt
          )
        )
      })
    if (changed) sweep()
  })
  const stopTimer = input.every
    ? input.every(sweep)
    : (() => {
        const timer = setInterval(sweep, 10000)
        return () => clearInterval(timer)
      })()
  sweep()
  return () => {
    stopped = true
    unsubscribe()
    stopTimer()
  }
}
