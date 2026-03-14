import { create } from 'zustand'

import type {
  ConnectionStatus,
  Message,
  ProviderSettings,
  RunStatus,
  Thread,
  YachiyoServerEvent,
} from '../types'

interface PendingAssistantMessage {
  messageId: string
  threadId: string
}

interface AppState {
  activeRunId: string | null
  activeThreadId: string | null
  archiveThread: (threadId: string) => Promise<void>
  composerValue: string
  connectionStatus: ConnectionStatus
  initialized: boolean
  isBootstrapping: boolean
  lastError: string | null
  messages: Record<string, Message[]>
  pendingAssistantMessages: Record<string, PendingAssistantMessage>
  renameThread: (threadId: string, title: string) => Promise<void>
  runStatus: RunStatus
  settings: ProviderSettings
  threads: Thread[]

  applyServerEvent: (event: YachiyoServerEvent) => void
  cancelActiveRun: () => Promise<void>
  createNewThread: () => Promise<void>
  initialize: () => Promise<void>
  sendMessage: (content: string) => Promise<void>
  setActiveThread: (id: string) => void
  setComposerValue: (value: string) => void
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  providerName: '',
  provider: 'anthropic',
  model: '',
  apiKey: '',
  baseUrl: '',
}

function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  return sortThreads([thread, ...threads.filter((item) => item.id !== thread.id)])
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const next = [...messages.filter((item) => item.id !== message.id), message]
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function finalizePendingMessage(
  messages: Message[],
  pending: PendingAssistantMessage | undefined,
  status: Message['status'],
): Message[] {
  if (!pending) return messages

  return messages.flatMap((message) => {
    if (message.id !== pending.messageId) return [message]
    if (!message.content.trim()) return []
    return [{ ...message, status }]
  })
}

let bootstrapPromise: Promise<void> | null = null
let unsubscribeFromServer: (() => void) | null = null

export const useAppStore = create<AppState>((set, get) => ({
  activeRunId: null,
  activeThreadId: null,
  archiveThread: async (threadId) => {
    await window.api.yachiyo.archiveThread({ threadId })
  },
  composerValue: '',
  connectionStatus: 'connecting',
  initialized: false,
  isBootstrapping: false,
  lastError: null,
  messages: {},
  pendingAssistantMessages: {},
  runStatus: 'idle',
  settings: DEFAULT_SETTINGS,
  threads: [],

  applyServerEvent: (event) => {
    set((state) => {
      if (event.type === 'thread.archived') {
        const threads = state.threads.filter((thread) => thread.id !== event.threadId)
        const messages = { ...state.messages }
        delete messages[event.threadId]

        return {
          activeThreadId:
            state.activeThreadId === event.threadId ? threads[0]?.id ?? null : state.activeThreadId,
          messages,
          threads,
        }
      }

      if (event.type === 'thread.created' || event.type === 'thread.updated') {
        return {
          threads: upsertThread(state.threads, event.thread),
        }
      }

      if (event.type === 'settings.updated') {
        return {
          lastError: null,
          settings: event.settings ?? state.settings ?? DEFAULT_SETTINGS,
        }
      }

      if (event.type === 'run.created') {
        return {
          activeRunId: event.runId,
          lastError: null,
          runStatus: 'running',
        }
      }

      if (event.type === 'message.started') {
        const nextMessage: Message = {
          id: event.messageId,
          threadId: event.threadId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: event.timestamp,
        }
        const nextThreadMessages = upsertMessage(state.messages[event.threadId] ?? [], nextMessage)

        return {
          messages: {
            ...state.messages,
            [event.threadId]: nextThreadMessages,
          },
          pendingAssistantMessages: {
            ...state.pendingAssistantMessages,
            [event.runId]: {
              messageId: event.messageId,
              threadId: event.threadId,
            },
          },
        }
      }

      if (event.type === 'message.delta') {
        const pending = state.pendingAssistantMessages[event.runId]
        if (!pending) return {}

        const nextThreadMessages = (state.messages[event.threadId] ?? []).map((message) =>
          message.id === pending.messageId
            ? {
                ...message,
                content: message.content + event.delta,
              }
            : message,
        )

        return {
          messages: {
            ...state.messages,
            [event.threadId]: nextThreadMessages,
          },
        }
      }

      if (event.type === 'message.completed') {
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]

        return {
          messages: {
            ...state.messages,
            [event.threadId]: upsertMessage(state.messages[event.threadId] ?? [], event.message),
          },
          pendingAssistantMessages,
        }
      }

      if (event.type === 'run.completed') {
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]

        return {
          activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
          pendingAssistantMessages,
          runStatus: 'idle',
        }
      }

      if (event.type === 'run.failed') {
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]

        return {
          activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
          lastError: event.error,
          messages: pending
            ? {
                ...state.messages,
                [pending.threadId]: finalizePendingMessage(
                  state.messages[pending.threadId] ?? [],
                  pending,
                  'failed',
                ),
              }
            : state.messages,
          pendingAssistantMessages,
          runStatus: 'failed',
        }
      }

      if (event.type === 'run.cancelled') {
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]

        return {
          activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
          messages: pending
            ? {
                ...state.messages,
                [pending.threadId]: finalizePendingMessage(
                  state.messages[pending.threadId] ?? [],
                  pending,
                  'failed',
                ),
              }
            : state.messages,
          pendingAssistantMessages,
          runStatus: 'cancelled',
        }
      }

      return {}
    })
  },

  cancelActiveRun: async () => {
    const runId = get().activeRunId
    if (!runId) return
    await window.api.yachiyo.cancelRun({ runId })
  },

  createNewThread: async () => {
    const thread = await window.api.yachiyo.createThread()
    set((state) => ({
      activeThreadId: thread.id,
      messages: {
        ...state.messages,
        [thread.id]: state.messages[thread.id] ?? [],
      },
      threads: upsertThread(state.threads, thread),
    }))
  },

  initialize: async () => {
    if (bootstrapPromise) {
      return bootstrapPromise
    }

    bootstrapPromise = (async () => {
      set({
        connectionStatus: 'connecting',
        isBootstrapping: true,
      })

      if (!unsubscribeFromServer) {
        unsubscribeFromServer = window.api.yachiyo.subscribe((event) => {
          useAppStore.getState().applyServerEvent(event)
        })
      }

      try {
        const payload = await window.api.yachiyo.bootstrap()
        set((state) => ({
          activeThreadId: state.activeThreadId ?? payload.threads[0]?.id ?? null,
          connectionStatus: 'connected',
          initialized: true,
          isBootstrapping: false,
          lastError: null,
          messages: payload.messagesByThread,
          settings: payload.settings ?? state.settings ?? DEFAULT_SETTINGS,
          threads: sortThreads(payload.threads),
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to bootstrap Yachiyo.'
        set({
          connectionStatus: 'disconnected',
          isBootstrapping: false,
          lastError: message,
          runStatus: 'failed',
        })
        throw error
      }
    })()

    return bootstrapPromise
  },

  renameThread: async (threadId, title) => {
    await window.api.yachiyo.renameThread({ threadId, title })
  },

  sendMessage: async (content) => {
    const trimmed = content.trim()
    if (!trimmed) return

    let threadId = get().activeThreadId

    if (!threadId) {
      const thread = await window.api.yachiyo.createThread()
      set((state) => ({
        activeThreadId: thread.id,
        messages: {
          ...state.messages,
          [thread.id]: state.messages[thread.id] ?? [],
        },
        threads: upsertThread(state.threads, thread),
      }))
      threadId = thread.id
    }

    try {
      const accepted = await window.api.yachiyo.sendChat({
        content: trimmed,
        threadId,
      })

      set((state) => ({
        activeThreadId: accepted.thread.id,
        composerValue: '',
        lastError: null,
        messages: {
          ...state.messages,
          [accepted.thread.id]: upsertMessage(
            state.messages[accepted.thread.id] ?? [],
            accepted.userMessage,
          ),
        },
        threads: upsertThread(state.threads, accepted.thread),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send the message.'
      set({
        lastError: message,
        runStatus: 'failed',
      })
    }
  },

  setActiveThread: (id) => set({ activeThreadId: id }),

  setComposerValue: (value) => set({ composerValue: value }),
}))
