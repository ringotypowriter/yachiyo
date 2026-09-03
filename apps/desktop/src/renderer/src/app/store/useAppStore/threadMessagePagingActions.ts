import type { AppState } from '../useAppStore.ts'
import {
  THREAD_MESSAGE_PAGE_SIZE,
  hasOlderThreadMessages,
  prependOlderThreadMessages
} from './threadMessagePaging.ts'
import { resolveThreadReadOutcome } from './threadMessageAuthority.ts'

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
      // A sync refresh landing mid-flight makes this page describe a history
      // that no longer exists; prepending it would restore pre-sync messages.
      const capturedAuthority = state.threadMessageAuthority[threadId]

      set((current) => ({
        threadMessagePaging: {
          ...current.threadMessagePaging,
          [threadId]: { hasOlder: true, loadingOlder: true }
        }
      }))

      // Only the read is guarded. A wider try would swallow a defect in the
      // fold below and report it to the reader as a failed read, which is both
      // a lie and silent.
      let data: Awaited<ReturnType<typeof loadThreadData>>
      try {
        data = await loadThreadData({
          threadId,
          limit: THREAD_MESSAGE_PAGE_SIZE,
          beforeMessageId: oldestLoadedId
        })
      } catch {
        // Leave hasOlder true so the user can try again; only clear the
        // in-flight flag. Reporting "no older messages" after a failed read
        // would be a lie the UI never corrects.
        set((current) => {
          // Unless the thread was replaced or deleted meanwhile: offering to
          // retry a page of a history that no longer exists is the same stale
          // write as applying one.
          if (
            resolveThreadReadOutcome({
              captured: capturedAuthority,
              current: current.threadMessageAuthority[threadId]
            }) !== 'apply'
          ) {
            return {}
          }
          return {
            threadMessagePaging: {
              ...current.threadMessagePaging,
              [threadId]: { hasOlder: true, loadingOlder: false }
            }
          }
        })
        return
      }

      set((current) => {
        if (
          resolveThreadReadOutcome({
            captured: capturedAuthority,
            current: current.threadMessageAuthority[threadId]
          }) !== 'apply'
        ) {
          // The event that invalidated this read already settled the thread's
          // paging state; writing anything here would undo it.
          return {}
        }
        const currentLoaded = current.messages[threadId]
        // The thread may have been dropped from memory while the page was in
        // flight; folding a page into a thread nobody is holding would
        // resurrect a partial history. Drop the paging entry with it so a
        // reopened thread does not inherit a stuck in-flight flag.
        if (!currentLoaded) {
          const remaining = { ...current.threadMessagePaging }
          delete remaining[threadId]
          return { threadMessagePaging: remaining }
        }
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
    }
  }
}
