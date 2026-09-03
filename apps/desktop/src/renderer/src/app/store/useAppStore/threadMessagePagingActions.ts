import type { AppState } from '../useAppStore.ts'
import {
  THREAD_MESSAGE_PAGE_SIZE,
  hasOlderThreadMessages,
  prependOlderThreadMessages
} from './threadMessagePaging.ts'

export function createThreadMessagePagingActions(input: {
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
  get: () => AppState
}): Pick<AppState, 'loadOlderThreadMessages'> {
  const { set, get } = input

  return {
    loadOlderThreadMessages: async (threadId) => {
      const state = get()
      const paging = state.threadMessagePaging[threadId]
      const loaded = state.messages[threadId]
      // Nothing above, already fetching, or nothing to anchor the cursor to.
      if (!paging?.hasOlder || paging.loadingOlder || !loaded?.length) return
      const loadThreadData = window.api?.yachiyo?.loadThreadData
      if (!loadThreadData) return

      const oldestLoadedId = loaded[0]?.id
      if (!oldestLoadedId) return

      set((current) => ({
        threadMessagePaging: {
          ...current.threadMessagePaging,
          [threadId]: { hasOlder: true, loadingOlder: true }
        }
      }))

      try {
        const data = await loadThreadData({
          threadId,
          limit: THREAD_MESSAGE_PAGE_SIZE,
          beforeMessageId: oldestLoadedId
        })
        set((current) => {
          const currentLoaded = current.messages[threadId]
          // The thread may have been dropped from memory while the page was in
          // flight; folding a page into a thread nobody is holding would
          // resurrect a partial history.
          if (!currentLoaded) return {}
          return {
            messages: {
              ...current.messages,
              [threadId]: prependOlderThreadMessages(currentLoaded, data.messages)
            },
            threadMessagePaging: {
              ...current.threadMessagePaging,
              [threadId]: {
                hasOlder: hasOlderThreadMessages(data.messages.length),
                loadingOlder: false
              }
            }
          }
        })
      } catch {
        // Leave hasOlder true so the user can try again; only clear the
        // in-flight flag. Reporting "no older messages" after a failed read
        // would be a lie the UI never corrects.
        set((current) => ({
          threadMessagePaging: {
            ...current.threadMessagePaging,
            [threadId]: { hasOlder: true, loadingOlder: false }
          }
        }))
      }
    }
  }
}
