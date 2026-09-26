import { create } from 'zustand'
import type { ReaderTarget } from '../lib/contentReader.ts'

export interface ReaderTab {
  id: string
  target: ReaderTarget
}
export interface ReaderConversation {
  tabs: ReaderTab[]
  activeId: string
  recent: string[]
}
export const EMPTY_READER_CONVERSATION: ReaderConversation = {
  tabs: [],
  activeId: 'chat',
  recent: ['chat']
}

function tabId(target: ReaderTarget): string {
  const resource =
    target.kind === 'diff'
      ? target.runId
      : target.kind === 'web'
        ? target.session
        : target.kind === 'image'
          ? (target.path ?? target.src)
          : target.path
  return JSON.stringify([target.kind, resource])
}
function activeTarget(conversation: ReaderConversation): ReaderTarget | null {
  return conversation.tabs.find((tab) => tab.id === conversation.activeId)?.target ?? null
}
interface ContentReaderState {
  refreshWeb: (
    threadId: string,
    session: string,
    load: (input: {
      threadId: string
    }) => Promise<Array<{ threadId: string; session: string; url: string; title?: string }>>
  ) => Promise<Extract<ReaderTarget, { kind: 'web' }> | null>
  conversations: Record<string, ReaderConversation>
  threadId: string | null
  target: ReaderTarget | null
  references: Record<string, ReaderTarget>
  ask: (threadId: string, id: string) => void
  open: (target: ReaderTarget, options?: { activate?: boolean }) => void
  openWeb: (
    threadId: string,
    url: string,
    load: (input: {
      threadId: string
      url: string
    }) => Promise<{ session: string; url: string; title?: string }>
  ) => Promise<void>
  setThread: (threadId: string | null) => void
  select: (threadId: string, id: string) => void
  closeTab: (threadId: string, id: string) => void
  close: () => void
  clearReference: () => void
  selectDiffFile: (runId: string, relativePath: string | undefined) => void
}

export const useContentReaderStore = create<ContentReaderState>((set, get) => ({
  conversations: {},
  threadId: null,
  target: null,
  references: {},
  refreshWeb: async (threadId, session, load) => {
    const pages = await load({ threadId })
    const page = pages.find((entry) => entry.threadId === threadId && entry.session === session)
    if (!page) return null
    const state = get()
    const tab = state.conversations[threadId]?.tabs.find(
      (entry) => entry.target.kind === 'web' && entry.target.session === session
    )
    if (tab?.target.kind !== 'web') return null
    const target = { ...tab.target, url: page.url, title: page.title }
    if (target.url !== tab.target.url || target.title !== tab.target.title)
      state.open(target, { activate: false })
    return target
  },
  ask: (threadId, id) => {
    const target = get().conversations[threadId]?.tabs.find((tab) => tab.id === id)?.target
    if (!target) return
    set((state) => ({ references: { ...state.references, [threadId]: target } }))
    get().select(threadId, 'chat')
  },
  openWeb: async (threadId, url, load) => {
    const previous = get().conversations[threadId]?.activeId ?? 'chat'
    const page = await load({ threadId, url })
    const state = get()
    state.open(
      { kind: 'web', threadId, ...page },
      {
        activate:
          state.threadId === threadId &&
          (state.conversations[threadId]?.activeId ?? 'chat') === previous
      }
    )
  },
  setThread: (threadId) =>
    set((state) => ({
      threadId,
      target: threadId
        ? activeTarget(state.conversations[threadId] ?? EMPTY_READER_CONVERSATION)
        : null
    })),
  open: (target, { activate = true } = {}) =>
    set((state) => {
      const previous = state.conversations[target.threadId] ?? EMPTY_READER_CONVERSATION
      const id = tabId(target)
      const existing = previous.tabs.find((tab) => tab.id === id)
      const tabs = existing
        ? previous.tabs.map((tab) =>
            tab.id === id ? { id, target: { ...tab.target, ...target } as ReaderTarget } : tab
          )
        : [...previous.tabs, { id, target }]
      const conversation = {
        tabs,
        activeId: activate ? id : previous.activeId,
        recent: activate
          ? [...previous.recent.filter((entry) => entry !== id), id]
          : previous.recent
      }
      return {
        conversations: { ...state.conversations, [target.threadId]: conversation },
        ...(activate
          ? {
              threadId: target.threadId,
              target: activeTarget(conversation)
            }
          : state.threadId === target.threadId
            ? { target: activeTarget(conversation) }
            : {})
      }
    }),
  select: (threadId, id) =>
    set((state) => {
      const previous = state.conversations[threadId] ?? EMPTY_READER_CONVERSATION
      if (id !== 'chat' && !previous.tabs.some((tab) => tab.id === id)) return {}
      const conversation = {
        ...previous,
        activeId: id,
        recent: [...previous.recent.filter((entry) => entry !== id), id]
      }
      return {
        conversations: { ...state.conversations, [threadId]: conversation },
        threadId,
        target: activeTarget(conversation)
      }
    }),
  closeTab: (threadId, id) =>
    set((state) => {
      const previous = state.conversations[threadId]
      if (!previous || id === 'chat') return {}
      const tabs = previous.tabs.filter((tab) => tab.id !== id)
      const recent = previous.recent.filter((entry) => entry !== id)
      const conversation = {
        tabs,
        recent,
        activeId: previous.activeId === id ? (recent.at(-1) ?? 'chat') : previous.activeId
      }
      return {
        conversations: { ...state.conversations, [threadId]: conversation },
        ...(state.threadId === threadId ? { target: activeTarget(conversation) } : {})
      }
    }),
  close: () => {
    const state = get()
    if (state.threadId)
      state.closeTab(state.threadId, state.conversations[state.threadId]?.activeId ?? 'chat')
  },
  clearReference: () =>
    set((state) => {
      const references = { ...state.references }
      if (state.threadId) delete references[state.threadId]
      return { references }
    }),
  selectDiffFile: (runId, relativePath) =>
    set((state) => {
      const target = state.target
      if (target?.kind !== 'diff' || target.runId !== runId) return {}
      const conversation = state.conversations[target.threadId]
      const updated = { ...target, relativePath }
      return {
        target: updated,
        conversations: {
          ...state.conversations,
          [target.threadId]: {
            ...conversation,
            tabs: conversation.tabs.map((tab) =>
              tab.id === tabId(target) ? { ...tab, target: updated } : tab
            )
          }
        }
      }
    })
}))
