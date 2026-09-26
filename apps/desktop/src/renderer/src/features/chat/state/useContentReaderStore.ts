import { create } from 'zustand'
import type { ReaderTarget } from '../lib/contentReader.ts'
import { previewDiscardCandidates, type PreviewReadingState } from '../lib/previewRetention.ts'

export interface ReaderTab {
  id: string
  target: ReaderTarget
  hot: boolean
  lastUsedAt: number
  generation: number
  reading: PreviewReadingState
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
  saveReading: (threadId: string, id: string, reading: PreviewReadingState) => void
  discardIdle: (
    now: number,
    release: (
      target: Extract<ReaderTarget, { kind: 'web' }>
    ) => Promise<{ released: boolean; reading?: PreviewReadingState; url?: string; title?: string }>
  ) => Promise<void>
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
  open: (target: ReaderTarget, options?: { activate?: boolean; resident?: boolean }) => void
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

function touchCurrent(state: ContentReaderState): Record<string, ReaderConversation> {
  const owner = state.threadId
  const entry = owner ? state.conversations[owner] : undefined
  if (!owner || !entry || entry.activeId === 'chat') return state.conversations
  return {
    ...state.conversations,
    [owner]: {
      ...entry,
      tabs: entry.tabs.map((tab) =>
        tab.id === entry.activeId ? { ...tab, lastUsedAt: Date.now() } : tab
      )
    }
  }
}

export const useContentReaderStore = create<ContentReaderState>((set, get) => ({
  conversations: {},
  threadId: null,
  target: null,
  references: {},
  saveReading: (threadId, id, reading) =>
    set((state) => {
      const entry = state.conversations[threadId]
      if (!entry?.tabs.some((tab) => tab.id === id)) return {}
      return {
        conversations: {
          ...state.conversations,
          [threadId]: {
            ...entry,
            tabs: entry.tabs.map((tab) =>
              tab.id === id ? { ...tab, reading: { ...tab.reading, ...reading } } : tab
            )
          }
        }
      }
    }),
  discardIdle: async (now, release) => {
    const protectedKeys = new Set<string>()
    while (true) {
      const state = get()
      const current = state.threadId
        ? JSON.stringify([state.threadId, state.conversations[state.threadId]?.activeId])
        : null
      const tabs = Object.entries(state.conversations).flatMap(([owner, entry]) =>
        entry.tabs.map((tab) => ({ ...tab, owner, key: JSON.stringify([owner, tab.id]) }))
      )
      const candidate = previewDiscardCandidates(tabs, current, now, protectedKeys)[0]
      if (!candidate) return
      const result =
        candidate.target.kind === 'web' ? await release(candidate.target) : { released: true }
      if (!result.released) {
        protectedKeys.add(candidate.key)
        continue
      }
      set((latest) => {
        const entry = latest.conversations[candidate.owner]
        const tab = entry?.tabs.find((tab) => tab.id === candidate.id)
        if (!tab || (tab.lastUsedAt !== candidate.lastUsedAt && candidate.target.kind !== 'web'))
          return {}
        const visible = latest.threadId === candidate.owner && entry.activeId === candidate.id
        return {
          conversations: {
            ...latest.conversations,
            [candidate.owner]: {
              ...entry,
              tabs: entry.tabs.map((tab) =>
                tab.id === candidate.id
                  ? {
                      ...tab,
                      hot: visible,
                      generation: tab.generation + 1,
                      reading: { ...tab.reading, ...result.reading },
                      target:
                        tab.target.kind === 'web'
                          ? {
                              ...tab.target,
                              url: result.url ?? tab.target.url,
                              title: result.title ?? tab.target.title
                            }
                          : tab.target
                    }
                  : tab
              )
            }
          }
        }
      })
    }
  },
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
        resident: true,
        activate:
          state.threadId === threadId &&
          (state.conversations[threadId]?.activeId ?? 'chat') === previous
      }
    )
  },
  setThread: (threadId) => {
    if (threadId) get().select(threadId, get().conversations[threadId]?.activeId ?? 'chat')
    else set((state) => ({ conversations: touchCurrent(state), threadId: null, target: null }))
  },
  open: (target, { activate = true, resident = false } = {}) =>
    set((state) => {
      if (target.kind === 'image' && target.path)
        target = { ...target, src: `yachiyo-asset://local/?p=${encodeURIComponent(target.path)}` }
      const conversations = activate ? touchCurrent(state) : state.conversations
      const previous = conversations[target.threadId] ?? EMPTY_READER_CONVERSATION
      const id = tabId(target)
      const existing = previous.tabs.find((tab) => tab.id === id)
      const tabs = existing
        ? previous.tabs.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  hot: activate || resident || tab.hot,
                  lastUsedAt: activate || resident ? Date.now() : tab.lastUsedAt,
                  target: { ...tab.target, ...target } as ReaderTarget
                }
              : tab
          )
        : [
            ...previous.tabs,
            {
              id,
              target,
              hot: activate || resident,
              lastUsedAt: Date.now(),
              generation: 0,
              reading: {}
            }
          ]
      const conversation = {
        tabs,
        activeId: activate ? id : previous.activeId,
        recent: activate
          ? [...previous.recent.filter((entry) => entry !== id), id]
          : previous.recent
      }
      return {
        conversations: { ...conversations, [target.threadId]: conversation },
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
      const conversations = touchCurrent(state)
      const previous = conversations[threadId] ?? EMPTY_READER_CONVERSATION
      if (id !== 'chat' && !previous.tabs.some((tab) => tab.id === id)) return {}
      const conversation = {
        ...previous,
        activeId: id,
        tabs: previous.tabs.map((tab) =>
          tab.id === id ? { ...tab, hot: true, lastUsedAt: Date.now() } : tab
        ),
        recent: [...previous.recent.filter((entry) => entry !== id), id]
      }
      return {
        conversations: { ...conversations, [threadId]: conversation },
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
      const activeId = previous.activeId === id ? (recent.at(-1) ?? 'chat') : previous.activeId
      const reference = state.references[threadId]
      let references = state.references
      if (
        reference?.kind === 'image' &&
        !reference.path &&
        /^(data|blob):/.test(reference.src) &&
        tabId(reference) === id
      ) {
        references = { ...references }
        delete references[threadId]
      }
      const conversation = {
        tabs: tabs.map((tab) =>
          tab.id === activeId ? { ...tab, hot: true, lastUsedAt: Date.now() } : tab
        ),
        recent,
        activeId
      }
      return {
        references,
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
