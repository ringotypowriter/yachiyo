import { create } from 'zustand'

import type {
  ConnectionStatus,
  Message,
  MessageImageRecord,
  MessageTextBlockRecord,
  ProviderSettings,
  RunRecord,
  RunStatus,
  SendChatMode,
  SettingsConfig,
  SkillCatalogEntry,
  Thread,
  ToolCallName,
  ToolCall,
  YachiyoServerEvent
} from '../types.ts'
import {
  hasMessagePayload,
  normalizeMessageImages
} from '../../../../shared/yachiyo/messageContent.ts'
import {
  DEFAULT_ENABLED_TOOL_NAMES,
  normalizeUserEnabledTools,
  normalizeSkillNames
} from '../../../../shared/yachiyo/protocol.ts'
import { collectMessagePath } from '../../../../shared/yachiyo/threadTree.ts'

interface PendingAssistantMessage {
  messageId: string
  threadId: string
  parentMessageId?: string
  shouldStartNewTextBlock: boolean
}

interface PendingSteerMessage {
  content: string
  createdAt: string
  images?: MessageImageRecord[]
}

export interface HarnessRecord {
  id: string
  runId: string
  threadId: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt?: string
  error?: string
}

export interface ComposerImageDraft extends MessageImageRecord {
  id: string
  status: 'loading' | 'ready' | 'failed'
  error?: string
}

export interface ComposerDraft {
  text: string
  images: ComposerImageDraft[]
  enabledSkillNames?: string[] | null
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: '',
  images: [],
  enabledSkillNames: null
}

interface AppState {
  activeArchivedThreadId: string | null
  activeRunId: string | null
  activeRequestMessageId: string | null
  activeRunThreadId: string | null
  activeThreadId: string | null
  archivedThreads: Thread[]
  archiveThread: (threadId: string) => Promise<void>
  availableSkills: SkillCatalogEntry[]
  compactThreadToAnotherThread: () => Promise<void>
  composerDrafts: Record<string, ComposerDraft>
  createBranch: (messageId: string) => Promise<void>
  config: SettingsConfig | null
  connectionStatus: ConnectionStatus
  deleteThread: (threadId: string) => Promise<void>
  enabledTools: ToolCallName[]
  harnessEvents: Record<string, HarnessRecord[]>
  initialized: boolean
  isBootstrapping: boolean
  lastError: string | null
  latestRunsByThread: Record<string, RunRecord>
  runsByThread: Record<string, RunRecord[]>
  removeComposerImage: (imageId: string, threadId?: string | null) => void
  deleteMessage: (messageId: string) => Promise<void>
  messages: Record<string, Message[]>
  pendingAssistantMessages: Record<string, PendingAssistantMessage>
  pendingSteerMessages: Record<string, PendingSteerMessage>
  pendingWorkspacePath: string | null
  renameThread: (threadId: string, title: string) => Promise<void>
  restoreThread: (threadId: string) => Promise<void>
  retryMessage: (messageId: string) => Promise<void>
  saveThread: (threadId: string, options?: { archiveAfterSave?: boolean }) => Promise<void>
  selectReplyBranch: (messageId: string) => Promise<void>
  runPhase: 'idle' | 'preparing' | 'streaming'
  runStatus: RunStatus
  settings: ProviderSettings
  threads: Thread[]
  threadListMode: 'active' | 'archived'
  toolCalls: Record<string, ToolCall[]>

  applyServerEvent: (event: YachiyoServerEvent) => void
  cancelActiveRun: () => Promise<void>
  createNewThread: () => Promise<void>
  initialize: () => Promise<void>
  selectModel: (providerName: string, model: string) => Promise<void>
  sendMessage: (mode?: SendChatMode) => Promise<void>
  setEnabledTools: (enabledTools: ToolCallName[]) => Promise<void>
  scrollToMessageId: string | null
  clearScrollToMessageId: () => void
  setActiveThread: (id: string, scrollToMessageId?: string) => void
  setActiveArchivedThread: (id: string) => void
  setComposerValue: (value: string) => void
  setComposerEnabledSkillNames: (enabledSkillNames: string[] | null) => void
  setPendingWorkspacePath: (workspacePath: string | null) => void
  setThreadWorkspace: (workspacePath: string | null) => Promise<void>
  setThreadListMode: (mode: 'active' | 'archived') => void
  setThreadPrivacyMode: (threadId: string, enabled: boolean) => Promise<void>
  toggleEnabledTool: (toolName: ToolCallName) => Promise<void>
  upsertComposerImage: (image: ComposerImageDraft, threadId?: string | null) => void
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  providerName: '',
  provider: 'anthropic',
  model: '',
  apiKey: '',
  baseUrl: ''
}

function areEnabledToolsEqual(left: ToolCallName[], right: ToolCallName[]): boolean {
  return left.length === right.length && left.every((toolName, index) => toolName === right[index])
}

function toggleEnabledTools(enabledTools: ToolCallName[], toolName: ToolCallName): ToolCallName[] {
  if (enabledTools.includes(toolName)) {
    return enabledTools.filter((currentToolName) => currentToolName !== toolName)
  }

  const nextEnabledTools = new Set([...enabledTools, toolName])
  return DEFAULT_ENABLED_TOOL_NAMES.filter((currentToolName) =>
    nextEnabledTools.has(currentToolName)
  )
}

function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  return sortThreads([thread, ...threads.filter((item) => item.id !== thread.id)])
}

function removeThread(threads: Thread[], threadId: string): Thread[] {
  return threads.filter((thread) => thread.id !== threadId)
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const next = [...messages.filter((item) => item.id !== message.id), message]
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function appendTextBlockDelta(input: {
  textBlocks: MessageTextBlockRecord[] | undefined
  delta: string
  timestamp: string
  shouldStartNewTextBlock: boolean
}): { textBlocks: MessageTextBlockRecord[]; shouldStartNewTextBlock: boolean } {
  const nextTextBlocks = [...(input.textBlocks ?? [])]
  const currentTextBlock =
    !input.shouldStartNewTextBlock && nextTextBlocks.length > 0 ? nextTextBlocks.at(-1) : undefined

  if (currentTextBlock) {
    nextTextBlocks[nextTextBlocks.length - 1] = {
      ...currentTextBlock,
      content: currentTextBlock.content + input.delta
    }
  } else {
    nextTextBlocks.push({
      id: `${input.timestamp}:${nextTextBlocks.length}`,
      content: input.delta,
      createdAt: input.timestamp
    })
  }

  return {
    textBlocks: nextTextBlocks,
    shouldStartNewTextBlock: false
  }
}

function replaceMessage(
  messages: Message[],
  message: Message,
  replacedMessageId?: string
): Message[] {
  const next = replacedMessageId
    ? messages.filter((item) => item.id !== replacedMessageId)
    : messages

  return upsertMessage(next, message)
}

function upsertToolCall(toolCalls: ToolCall[], toolCall: ToolCall): ToolCall[] {
  const next = [...toolCalls.filter((item) => item.id !== toolCall.id), toolCall]
  return next.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

function upsertLatestRun(
  latestRunsByThread: Record<string, RunRecord>,
  run: RunRecord
): Record<string, RunRecord> {
  return {
    ...latestRunsByThread,
    [run.threadId]: run
  }
}

function upsertRunRecord(runs: RunRecord[], run: RunRecord): RunRecord[] {
  const next = [...runs.filter((entry) => entry.id !== run.id), run]
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function updateRunRecord(
  runsByThread: Record<string, RunRecord[]>,
  threadId: string,
  runId: string,
  updater: (run: RunRecord | undefined) => RunRecord
): Record<string, RunRecord[]> {
  const runs = runsByThread[threadId] ?? []

  return {
    ...runsByThread,
    [threadId]: upsertRunRecord(runs, updater(runs.find((entry) => entry.id === runId)))
  }
}

function bootstrapRunsByThread(
  latestRunsByThread: Record<string, RunRecord>
): Record<string, RunRecord[]> {
  return Object.fromEntries(
    Object.values(latestRunsByThread).map((run) => [run.threadId, [run]] as const)
  )
}

const NEW_THREAD_DRAFT_KEY = '__new__'
const DEFAULT_THREAD_TITLE = 'New Chat'

function getComposerDraftKey(threadId: string | null): string {
  return threadId ?? NEW_THREAD_DRAFT_KEY
}

function getComposerDraft(
  state: Pick<AppState, 'activeThreadId' | 'composerDrafts'>
): ComposerDraft {
  return state.composerDrafts[getComposerDraftKey(state.activeThreadId)] ?? EMPTY_COMPOSER_DRAFT
}

function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length === 0 && draft.images.length === 0 && draft.enabledSkillNames === null
  )
}

function isThreadReusableNewChat(
  input: Pick<AppState, 'composerDrafts' | 'messages'> & {
    pendingWorkspacePath: string | null
  },
  thread: Thread
): boolean {
  if (thread.title !== DEFAULT_THREAD_TITLE) {
    return false
  }

  if ((input.messages[thread.id] ?? []).length > 0) {
    return false
  }

  if (thread.preview || thread.headMessageId) {
    return false
  }

  const draft = input.composerDrafts[getComposerDraftKey(thread.id)]
  if (draft && !isComposerDraftEmpty(draft)) {
    return false
  }

  return normalizeWorkspacePath(thread.workspacePath) === input.pendingWorkspacePath
}

function upsertComposerDraft(
  drafts: Record<string, ComposerDraft>,
  draftKey: string,
  draft: ComposerDraft
): Record<string, ComposerDraft> {
  if (isComposerDraftEmpty(draft)) {
    const next = { ...drafts }
    delete next[draftKey]
    return next
  }

  return {
    ...drafts,
    [draftKey]: draft
  }
}

function updateComposerDraft(
  drafts: Record<string, ComposerDraft>,
  draftKey: string,
  updater: (draft: ComposerDraft) => ComposerDraft
): Record<string, ComposerDraft> {
  return upsertComposerDraft(drafts, draftKey, updater(drafts[draftKey] ?? EMPTY_COMPOSER_DRAFT))
}

function moveComposerDraft(
  drafts: Record<string, ComposerDraft>,
  fromDraftKey: string,
  toDraftKey: string
): Record<string, ComposerDraft> {
  if (fromDraftKey === toDraftKey) {
    return drafts
  }

  const current = drafts[fromDraftKey]
  if (!current) {
    return drafts
  }

  const next = { ...drafts }
  delete next[fromDraftKey]
  next[toDraftKey] = current
  return next
}

function removeComposerDraft(
  drafts: Record<string, ComposerDraft>,
  threadId: string | null
): Record<string, ComposerDraft> {
  const next = { ...drafts }
  delete next[getComposerDraftKey(threadId)]
  return next
}

function removePendingSteerMessage(
  pendingSteerMessages: Record<string, PendingSteerMessage>,
  threadId: string
): Record<string, PendingSteerMessage> {
  const next = { ...pendingSteerMessages }
  delete next[threadId]
  return next
}

function normalizeWorkspacePath(workspacePath: string | null | undefined): string | null {
  const normalized = workspacePath?.trim()
  return normalized ? normalized : null
}

function resolveEffectiveEnabledSkillNames(input: {
  config: SettingsConfig | null
  draft: ComposerDraft
}): string[] {
  return normalizeSkillNames(input.draft.enabledSkillNames ?? input.config?.skills?.enabled)
}

function toReadyMessageImages(images: ComposerImageDraft[]): MessageImageRecord[] {
  return normalizeMessageImages(
    images
      .filter((image) => image.status === 'ready')
      .map((image) => ({
        dataUrl: image.dataUrl,
        mediaType: image.mediaType,
        ...(image.filename ? { filename: image.filename } : {})
      }))
  )
}

function finalizePendingMessage(
  messages: Message[],
  pending: PendingAssistantMessage | undefined,
  status: Message['status'],
  options: { preserveEmpty?: boolean } = {}
): Message[] {
  if (!pending) return messages

  return messages.flatMap((message) => {
    if (message.id !== pending.messageId) return [message]
    if (!message.content.trim() && !options.preserveEmpty) return []
    return [{ ...message, status }]
  })
}

function resolveActiveRequestMessageId(
  thread: Pick<Thread, 'headMessageId'>,
  messages: Message[],
  fallback: string | null
): string | null {
  const targetMessageId =
    thread.headMessageId && messages.some((message) => message.id === thread.headMessageId)
      ? thread.headMessageId
      : fallback && messages.some((message) => message.id === fallback)
        ? fallback
        : null

  if (!targetMessageId) {
    return fallback
  }

  const activeRequestMessage = [...collectMessagePath(messages, targetMessageId)]
    .reverse()
    .find((message) => message.role === 'user')

  return activeRequestMessage?.id ?? fallback
}

let bootstrapPromise: Promise<void> | null = null
let unsubscribeFromServer: (() => void) | null = null
let availableSkillsRequestId = 0

async function refreshAvailableSkills(
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState
): Promise<void> {
  const requestId = ++availableSkillsRequestId
  const state = get()
  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId) ?? null
  const workspacePath = normalizeWorkspacePath(
    activeThread?.workspacePath ?? state.pendingWorkspacePath
  )

  try {
    const availableSkills = await window.api.yachiyo.listSkills(
      workspacePath ? { workspacePaths: [workspacePath] } : undefined
    )

    if (requestId !== availableSkillsRequestId) {
      return
    }

    set({ availableSkills })
  } catch (error) {
    console.warn('[yachiyo][skills] failed to refresh available skills', error)
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  activeArchivedThreadId: null,
  activeRunId: null,
  activeRequestMessageId: null,
  activeRunThreadId: null,
  activeThreadId: null,
  scrollToMessageId: null,
  archivedThreads: [],
  availableSkills: [],
  archiveThread: async (threadId) => {
    try {
      await window.api.yachiyo.archiveThread({ threadId })
      set({ lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to archive this thread.'
      set({ lastError: message })
      throw error
    }
  },
  compactThreadToAnotherThread: async () => {
    const threadId = get().activeThreadId
    if (!threadId) {
      return
    }

    try {
      const accepted = await window.api.yachiyo.compactThreadToAnotherThread({ threadId })
      set((state) => ({
        activeRequestMessageId: null,
        activeRunId: accepted.runId,
        activeRunThreadId: accepted.thread.id,
        activeThreadId: accepted.thread.id,
        lastError: null,
        runPhase: 'preparing',
        runStatus: 'running',
        threadListMode: 'active',
        messages: {
          ...state.messages,
          [accepted.thread.id]: state.messages[accepted.thread.id] ?? []
        },
        toolCalls: {
          ...state.toolCalls,
          [accepted.thread.id]: state.toolCalls[accepted.thread.id] ?? []
        },
        threads: upsertThread(state.threads, accepted.thread)
      }))
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to compact into another thread.'
      set({ lastError: message })
      throw error
    }
  },
  createBranch: async (messageId) => {
    const threadId = get().activeThreadId
    if (!threadId) {
      return
    }

    try {
      const snapshot = await window.api.yachiyo.createBranch({ threadId, messageId })
      set((state) => ({
        activeThreadId: snapshot.thread.id,
        threadListMode: 'active',
        harnessEvents: {
          ...state.harnessEvents,
          [snapshot.thread.id]: []
        },
        lastError: null,
        messages: {
          ...state.messages,
          [snapshot.thread.id]: snapshot.messages
        },
        toolCalls: {
          ...state.toolCalls,
          [snapshot.thread.id]: snapshot.toolCalls
        },
        threads: upsertThread(state.threads, snapshot.thread)
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create a branch.'
      set({ lastError: message })
      throw error
    }
  },
  composerDrafts: {},
  config: null,
  connectionStatus: 'connecting',
  deleteThread: async (threadId) => {
    try {
      await window.api.yachiyo.deleteThread({ threadId })
      set({ lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete this thread.'
      set({ lastError: message })
      throw error
    }
  },
  enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
  harnessEvents: {},
  initialized: false,
  isBootstrapping: false,
  lastError: null,
  latestRunsByThread: {},
  runsByThread: {},
  removeComposerImage: (imageId, threadId) =>
    set((state) => {
      const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)

      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
          ...draft,
          images: draft.images.filter((image) => image.id !== imageId)
        }))
      }
    }),
  messages: {},
  pendingAssistantMessages: {},
  pendingSteerMessages: {},
  pendingWorkspacePath: null,
  restoreThread: async (threadId) => {
    try {
      await window.api.yachiyo.restoreThread({ threadId })
      set({ lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to restore this thread.'
      set({ lastError: message })
      throw error
    }
  },
  saveThread: async (threadId, options = {}) => {
    try {
      await window.api.yachiyo.saveThread({
        threadId,
        archiveAfterSave: options.archiveAfterSave
      })
      set({ lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save this thread.'
      set({ lastError: message })
      throw error
    }
  },
  deleteMessage: async (messageId) => {
    const threadId = get().activeThreadId
    if (!threadId) {
      return
    }

    try {
      const snapshot = await window.api.yachiyo.deleteMessage({ threadId, messageId })
      set((state) => ({
        harnessEvents: {
          ...state.harnessEvents,
          [threadId]: []
        },
        lastError: null,
        messages: {
          ...state.messages,
          [threadId]: snapshot.messages
        },
        toolCalls: {
          ...state.toolCalls,
          [threadId]: snapshot.toolCalls
        },
        threads: upsertThread(state.threads, snapshot.thread)
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete this message.'
      set({ lastError: message })
      throw error
    }
  },
  runPhase: 'idle',
  runStatus: 'idle',
  settings: DEFAULT_SETTINGS,
  threads: [],
  threadListMode: 'active',
  toolCalls: {},

  applyServerEvent: (event) => {
    set((state) => {
      if (event.type === 'thread.archived') {
        const threads = removeThread(state.threads, event.threadId)
        const archivedThreads = upsertThread(state.archivedThreads, event.thread)
        return {
          activeThreadId:
            state.activeThreadId === event.threadId
              ? (threads[0]?.id ?? null)
              : state.activeThreadId,
          activeArchivedThreadId:
            state.activeArchivedThreadId === event.threadId
              ? event.threadId
              : (state.activeArchivedThreadId ?? event.threadId),
          archivedThreads,
          composerDrafts: removeComposerDraft(state.composerDrafts, event.threadId),
          threads
        }
      }

      if (event.type === 'thread.restored') {
        const archivedThreads = removeThread(state.archivedThreads, event.threadId)
        const threads = upsertThread(state.threads, event.thread)
        return {
          activeArchivedThreadId:
            state.activeArchivedThreadId === event.threadId
              ? (archivedThreads[0]?.id ?? null)
              : state.activeArchivedThreadId,
          activeThreadId: event.thread.id,
          archivedThreads,
          threadListMode: 'active',
          threads
        }
      }

      if (event.type === 'thread.deleted') {
        const threads = removeThread(state.threads, event.threadId)
        const archivedThreads = removeThread(state.archivedThreads, event.threadId)
        const messages = { ...state.messages }
        delete messages[event.threadId]
        const harnessEvents = { ...state.harnessEvents }
        delete harnessEvents[event.threadId]
        const latestRunsByThread = { ...state.latestRunsByThread }
        delete latestRunsByThread[event.threadId]
        const runsByThread = { ...state.runsByThread }
        delete runsByThread[event.threadId]
        const toolCalls = { ...state.toolCalls }
        delete toolCalls[event.threadId]

        return {
          activeArchivedThreadId:
            state.activeArchivedThreadId === event.threadId
              ? (archivedThreads[0]?.id ?? null)
              : state.activeArchivedThreadId,
          activeThreadId:
            state.activeThreadId === event.threadId
              ? (threads[0]?.id ?? null)
              : state.activeThreadId,
          archivedThreads,
          composerDrafts: removeComposerDraft(state.composerDrafts, event.threadId),
          harnessEvents,
          latestRunsByThread,
          runsByThread,
          messages,
          pendingSteerMessages: removePendingSteerMessage(
            state.pendingSteerMessages,
            event.threadId
          ),
          toolCalls,
          threads
        }
      }

      if (event.type === 'thread.created' || event.type === 'thread.updated') {
        const nextActiveRequestMessageId =
          state.activeRunThreadId === event.threadId
            ? resolveActiveRequestMessageId(
                event.thread,
                state.messages[event.threadId] ?? [],
                state.activeRequestMessageId
              )
            : state.activeRequestMessageId
        const shouldClearPendingSteer =
          Boolean(state.pendingSteerMessages[event.threadId]) &&
          state.activeRunThreadId === event.threadId &&
          Boolean(event.thread.headMessageId) &&
          event.thread.headMessageId !== state.activeRequestMessageId

        return {
          activeRequestMessageId: nextActiveRequestMessageId,
          archivedThreads: removeThread(state.archivedThreads, event.threadId),
          pendingSteerMessages: shouldClearPendingSteer
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          threads: upsertThread(state.threads, event.thread)
        }
      }

      if (event.type === 'thread.state.replaced') {
        const nextActiveRequestMessageId =
          state.activeRunThreadId === event.threadId
            ? resolveActiveRequestMessageId(
                event.thread,
                event.messages,
                state.activeRequestMessageId
              )
            : state.activeRequestMessageId

        return {
          activeRequestMessageId: nextActiveRequestMessageId,
          archivedThreads: removeThread(state.archivedThreads, event.threadId),
          harnessEvents: {
            ...state.harnessEvents,
            [event.threadId]: []
          },
          messages: {
            ...state.messages,
            [event.threadId]: event.messages
          },
          pendingSteerMessages: removePendingSteerMessage(
            state.pendingSteerMessages,
            event.threadId
          ),
          toolCalls: {
            ...state.toolCalls,
            [event.threadId]: event.toolCalls
          },
          threads: upsertThread(state.threads, event.thread)
        }
      }

      if (event.type === 'settings.updated') {
        return {
          config: event.config ?? state.config,
          enabledTools: normalizeUserEnabledTools(event.config?.enabledTools, state.enabledTools),
          lastError: null,
          settings: event.settings ?? state.settings ?? DEFAULT_SETTINGS
        }
      }

      if (event.type === 'run.created') {
        return {
          activeRunId: event.runId,
          activeRequestMessageId: event.requestMessageId ?? null,
          activeRunThreadId: event.threadId,
          lastError: null,
          latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
            id: event.runId,
            threadId: event.threadId,
            status: 'running',
            createdAt: event.timestamp,
            ...(event.requestMessageId ? { requestMessageId: event.requestMessageId } : {})
          }),
          runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
            ...run,
            id: event.runId,
            threadId: event.threadId,
            status: 'running',
            createdAt: run?.createdAt ?? event.timestamp,
            ...(event.requestMessageId ? { requestMessageId: event.requestMessageId } : {}),
            recalledMemoryEntries: run?.recalledMemoryEntries,
            recallDecision: run?.recallDecision
          })),
          runPhase: 'preparing',
          runStatus: 'running'
        }
      }

      if (event.type === 'run.memory.recalled') {
        return {
          latestRunsByThread:
            state.latestRunsByThread[event.threadId]?.id === event.runId
              ? upsertLatestRun(state.latestRunsByThread, {
                  ...state.latestRunsByThread[event.threadId]!,
                  recalledMemoryEntries: event.recalledMemoryEntries,
                  recallDecision: event.recallDecision
                })
              : state.latestRunsByThread,
          runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
            ...run,
            id: event.runId,
            threadId: event.threadId,
            status: run?.status ?? 'running',
            createdAt: run?.createdAt ?? event.timestamp,
            ...(event.requestMessageId ? { requestMessageId: event.requestMessageId } : {}),
            recalledMemoryEntries: event.recalledMemoryEntries,
            recallDecision: event.recallDecision,
            ...(run?.completedAt ? { completedAt: run.completedAt } : {}),
            ...(run?.error ? { error: run.error } : {})
          }))
        }
      }

      if (event.type === 'run.context.compiled') {
        return {
          latestRunsByThread:
            state.latestRunsByThread[event.threadId]?.id === event.runId
              ? upsertLatestRun(state.latestRunsByThread, {
                  ...state.latestRunsByThread[event.threadId]!,
                  contextSources: event.contextSources
                })
              : state.latestRunsByThread,
          runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
            ...run,
            id: event.runId,
            threadId: event.threadId,
            status: run?.status ?? 'running',
            createdAt: run?.createdAt ?? event.timestamp,
            contextSources: event.contextSources,
            ...(run?.completedAt ? { completedAt: run.completedAt } : {}),
            ...(run?.error ? { error: run.error } : {})
          }))
        }
      }

      if (event.type === 'message.started') {
        const nextMessage: Message = {
          id: event.messageId,
          threadId: event.threadId,
          parentMessageId: event.parentMessageId,
          role: 'assistant',
          content: '',
          textBlocks: [],
          status: 'streaming',
          createdAt: event.timestamp
        }
        const nextThreadMessages = upsertMessage(state.messages[event.threadId] ?? [], nextMessage)

        return {
          messages: {
            ...state.messages,
            [event.threadId]: nextThreadMessages
          },
          pendingAssistantMessages: {
            ...state.pendingAssistantMessages,
            [event.runId]: {
              messageId: event.messageId,
              parentMessageId: event.parentMessageId,
              threadId: event.threadId,
              shouldStartNewTextBlock: true
            }
          }
        }
      }

      if (event.type === 'message.delta') {
        const pending = state.pendingAssistantMessages[event.runId]
        if (!pending) return {}

        let nextPendingAssistantMessage = pending

        const nextThreadMessages = (state.messages[event.threadId] ?? []).map((message) =>
          message.id === pending.messageId
            ? (() => {
                const nextTextBlockState = appendTextBlockDelta({
                  textBlocks: message.textBlocks,
                  delta: event.delta,
                  timestamp: event.timestamp,
                  shouldStartNewTextBlock: pending.shouldStartNewTextBlock
                })
                nextPendingAssistantMessage = {
                  ...pending,
                  shouldStartNewTextBlock: nextTextBlockState.shouldStartNewTextBlock
                }

                return {
                  ...message,
                  content: message.content + event.delta,
                  textBlocks: nextTextBlockState.textBlocks
                }
              })()
            : message
        )

        return {
          messages: {
            ...state.messages,
            [event.threadId]: nextThreadMessages
          },
          pendingAssistantMessages: {
            ...state.pendingAssistantMessages,
            [event.runId]: nextPendingAssistantMessage
          },
          runPhase: 'streaming'
        }
      }

      if (event.type === 'message.completed') {
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]

        return {
          messages: {
            ...state.messages,
            [event.threadId]: upsertMessage(state.messages[event.threadId] ?? [], event.message)
          },
          pendingAssistantMessages
        }
      }

      if (event.type === 'tool.updated') {
        const pending = state.pendingAssistantMessages[event.runId]
        return {
          pendingAssistantMessages: pending
            ? {
                ...state.pendingAssistantMessages,
                [event.runId]: {
                  ...pending,
                  shouldStartNewTextBlock: true
                }
              }
            : state.pendingAssistantMessages,
          toolCalls: {
            ...state.toolCalls,
            [event.threadId]: upsertToolCall(state.toolCalls[event.threadId] ?? [], event.toolCall)
          }
        }
      }

      if (event.type === 'run.completed') {
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        return {
          activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
          activeRequestMessageId:
            state.activeRunId === event.runId ? null : state.activeRequestMessageId,
          activeRunThreadId: state.activeRunId === event.runId ? null : state.activeRunThreadId,
          latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
            id: event.runId,
            threadId: event.threadId,
            status: 'completed',
            createdAt: existingLatestRun?.createdAt ?? event.timestamp,
            requestMessageId: existingLatestRun?.requestMessageId,
            recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
            recallDecision: existingLatestRun?.recallDecision,
            contextSources: existingLatestRun?.contextSources,
            completedAt: event.timestamp
          }),
          runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
            ...run,
            id: event.runId,
            threadId: event.threadId,
            status: 'completed',
            createdAt: run?.createdAt ?? event.timestamp,
            requestMessageId: run?.requestMessageId,
            recalledMemoryEntries: run?.recalledMemoryEntries,
            recallDecision: run?.recallDecision,
            contextSources: run?.contextSources,
            completedAt: event.timestamp
          })),
          pendingAssistantMessages,
          pendingSteerMessages:
            state.activeRunThreadId === event.threadId
              ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
              : state.pendingSteerMessages,
          runPhase: 'idle',
          runStatus: 'idle'
        }
      }

      if (event.type === 'run.failed') {
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        return {
          activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
          activeRequestMessageId:
            state.activeRunId === event.runId ? null : state.activeRequestMessageId,
          activeRunThreadId: state.activeRunId === event.runId ? null : state.activeRunThreadId,
          lastError: event.error,
          latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
            id: event.runId,
            threadId: event.threadId,
            status: 'failed',
            error: event.error,
            createdAt: existingLatestRun?.createdAt ?? event.timestamp,
            requestMessageId: existingLatestRun?.requestMessageId,
            recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
            recallDecision: existingLatestRun?.recallDecision,
            contextSources: existingLatestRun?.contextSources,
            completedAt: event.timestamp
          }),
          runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
            ...run,
            id: event.runId,
            threadId: event.threadId,
            status: 'failed',
            error: event.error,
            createdAt: run?.createdAt ?? event.timestamp,
            requestMessageId: run?.requestMessageId,
            recalledMemoryEntries: run?.recalledMemoryEntries,
            recallDecision: run?.recallDecision,
            contextSources: run?.contextSources,
            completedAt: event.timestamp
          })),
          messages: pending
            ? {
                ...state.messages,
                [pending.threadId]: finalizePendingMessage(
                  state.messages[pending.threadId] ?? [],
                  pending,
                  'failed'
                )
              }
            : state.messages,
          pendingAssistantMessages,
          pendingSteerMessages:
            state.activeRunThreadId === event.threadId
              ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
              : state.pendingSteerMessages,
          runPhase: 'idle',
          runStatus: 'failed'
        }
      }

      if (event.type === 'run.cancelled') {
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        return {
          activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
          activeRequestMessageId:
            state.activeRunId === event.runId ? null : state.activeRequestMessageId,
          activeRunThreadId: state.activeRunId === event.runId ? null : state.activeRunThreadId,
          latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
            id: event.runId,
            threadId: event.threadId,
            status: 'cancelled',
            createdAt: existingLatestRun?.createdAt ?? event.timestamp,
            requestMessageId: existingLatestRun?.requestMessageId,
            recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
            recallDecision: existingLatestRun?.recallDecision,
            contextSources: existingLatestRun?.contextSources,
            completedAt: event.timestamp
          }),
          runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
            ...run,
            id: event.runId,
            threadId: event.threadId,
            status: 'cancelled',
            createdAt: run?.createdAt ?? event.timestamp,
            requestMessageId: run?.requestMessageId,
            recalledMemoryEntries: run?.recalledMemoryEntries,
            recallDecision: run?.recallDecision,
            contextSources: run?.contextSources,
            completedAt: event.timestamp
          })),
          messages: pending
            ? {
                ...state.messages,
                [pending.threadId]: finalizePendingMessage(
                  state.messages[pending.threadId] ?? [],
                  pending,
                  'stopped',
                  { preserveEmpty: true }
                )
              }
            : state.messages,
          pendingAssistantMessages,
          pendingSteerMessages:
            state.activeRunThreadId === event.threadId
              ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
              : state.pendingSteerMessages,
          runPhase: 'idle',
          runStatus: 'cancelled'
        }
      }

      if (event.type === 'harness.started') {
        const record: HarnessRecord = {
          id: event.harnessId,
          runId: event.runId,
          threadId: event.threadId,
          name: event.name,
          status: 'running',
          startedAt: event.timestamp
        }
        const existing = state.harnessEvents[event.threadId] ?? []
        const next = [...existing.filter((h) => h.id !== record.id), record].sort((a, b) =>
          a.startedAt.localeCompare(b.startedAt)
        )
        return { harnessEvents: { ...state.harnessEvents, [event.threadId]: next } }
      }

      if (event.type === 'harness.finished') {
        const existing = state.harnessEvents[event.threadId] ?? []
        const next = existing.map((h) =>
          h.id === event.harnessId
            ? { ...h, status: event.status, finishedAt: event.timestamp, error: event.error }
            : h
        )
        return { harnessEvents: { ...state.harnessEvents, [event.threadId]: next } }
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
    const pendingWorkspacePath = normalizeWorkspacePath(get().pendingWorkspacePath)
    const reusableThread = get().threads.find((thread) =>
      isThreadReusableNewChat(
        {
          composerDrafts: get().composerDrafts,
          messages: get().messages,
          pendingWorkspacePath
        },
        thread
      )
    )

    if (reusableThread) {
      set({
        activeThreadId: reusableThread.id,
        pendingWorkspacePath: null,
        threadListMode: 'active'
      })
      await refreshAvailableSkills(set, get)
      return
    }

    const thread = await window.api.yachiyo.createThread(
      pendingWorkspacePath ? { workspacePath: pendingWorkspacePath } : undefined
    )
    set((state) => ({
      activeArchivedThreadId: state.activeArchivedThreadId,
      activeThreadId: thread.id,
      composerDrafts: removeComposerDraft(state.composerDrafts, null),
      pendingWorkspacePath: null,
      threadListMode: 'active',
      messages: {
        ...state.messages,
        [thread.id]: state.messages[thread.id] ?? []
      },
      toolCalls: {
        ...state.toolCalls,
        [thread.id]: state.toolCalls[thread.id] ?? []
      },
      threads: upsertThread(state.threads, thread)
    }))
    await refreshAvailableSkills(set, get)
  },

  initialize: async () => {
    if (bootstrapPromise) {
      return bootstrapPromise
    }

    bootstrapPromise = (async () => {
      set({
        connectionStatus: 'connecting',
        isBootstrapping: true
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
          activeArchivedThreadId:
            state.activeArchivedThreadId ?? payload.archivedThreads[0]?.id ?? null,
          archivedThreads: sortThreads(payload.archivedThreads),
          config: payload.config ?? state.config,
          connectionStatus: 'connected',
          enabledTools: normalizeUserEnabledTools(payload.config?.enabledTools, state.enabledTools),
          initialized: true,
          isBootstrapping: false,
          lastError: null,
          latestRunsByThread: payload.latestRunsByThread,
          runsByThread: bootstrapRunsByThread(payload.latestRunsByThread),
          messages: payload.messagesByThread,
          settings: payload.settings ?? state.settings ?? DEFAULT_SETTINGS,
          threads: sortThreads(payload.threads),
          toolCalls: payload.toolCallsByThread
        }))
        await refreshAvailableSkills(set, get)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to bootstrap Yachiyo.'
        set({
          connectionStatus: 'disconnected',
          isBootstrapping: false,
          lastError: message,
          runPhase: 'idle',
          runStatus: 'failed'
        })
        throw error
      }
    })()

    return bootstrapPromise
  },

  renameThread: async (threadId, title) => {
    await window.api.yachiyo.renameThread({ threadId, title })
  },

  setThreadPrivacyMode: async (threadId, enabled) => {
    const thread = await window.api.yachiyo.setThreadPrivacyMode({ threadId, enabled })
    set((state) => ({ threads: upsertThread(state.threads, thread) }))
  },

  retryMessage: async (messageId) => {
    const currentState = get()
    const { activeThreadId: threadId, enabledTools } = currentState
    if (!threadId) {
      return
    }

    const enabledSkillNames = resolveEffectiveEnabledSkillNames({
      config: currentState.config,
      draft: getComposerDraft(currentState)
    })

    try {
      const accepted = await window.api.yachiyo.retryMessage({
        threadId,
        messageId,
        enabledTools,
        enabledSkillNames
      })
      set((state) => ({
        activeRunId: accepted.runId,
        activeRequestMessageId: accepted.requestMessageId,
        activeRunThreadId: accepted.thread.id,
        activeThreadId: accepted.thread.id,
        lastError: null,
        runPhase: 'preparing',
        runStatus: 'running',
        threadListMode: 'active',
        threads: upsertThread(state.threads, accepted.thread)
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to retry this response.'
      set({ lastError: message })
      throw error
    }
  },

  selectReplyBranch: async (messageId) => {
    const threadId = get().activeThreadId
    if (!threadId) {
      return
    }

    try {
      await window.api.yachiyo.selectReplyBranch({ threadId, assistantMessageId: messageId })
      set({ lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to switch reply branches.'
      set({ lastError: message })
      throw error
    }
  },

  selectModel: async (providerName, model) => {
    if (get().runPhase !== 'idle' || get().runStatus === 'running') {
      return
    }

    await window.api.yachiyo.saveSettings({ providerName, model })
  },

  sendMessage: async (mode = 'normal') => {
    const currentState = get()
    const draft = getComposerDraft(currentState)
    const trimmed = draft.text.trim()
    const images = toReadyMessageImages(draft.images)
    const enabledTools = currentState.enabledTools
    const enabledSkillNames = resolveEffectiveEnabledSkillNames({
      config: currentState.config,
      draft
    })

    if (
      draft.images.some((image) => image.status === 'loading' || image.status === 'failed') ||
      !hasMessagePayload({ content: trimmed, images })
    ) {
      return
    }

    let threadId = currentState.activeThreadId
    const workspacePath = normalizeWorkspacePath(
      threadId
        ? currentState.threads.find((thread) => thread.id === threadId)?.workspacePath
        : currentState.pendingWorkspacePath
    )

    if (!threadId && mode !== 'normal') {
      return
    }

    if (!threadId) {
      const thread = await window.api.yachiyo.createThread(
        workspacePath ? { workspacePath } : undefined
      )
      set((state) => ({
        activeThreadId: thread.id,
        pendingWorkspacePath: null,
        threadListMode: 'active',
        composerDrafts: moveComposerDraft(
          state.composerDrafts,
          getComposerDraftKey(null),
          getComposerDraftKey(thread.id)
        ),
        messages: {
          ...state.messages,
          [thread.id]: state.messages[thread.id] ?? []
        },
        toolCalls: {
          ...state.toolCalls,
          [thread.id]: state.toolCalls[thread.id] ?? []
        },
        threads: upsertThread(state.threads, thread)
      }))
      threadId = thread.id
    }

    try {
      const accepted = await window.api.yachiyo.sendChat({
        content: trimmed,
        enabledTools,
        enabledSkillNames:
          mode === 'follow-up' || draft.enabledSkillNames !== null ? enabledSkillNames : undefined,
        ...(images.length > 0 ? { images } : {}),
        ...(mode !== 'normal' ? { mode } : {}),
        threadId
      })

      const acceptedKind =
        accepted.kind ??
        (mode === 'follow-up'
          ? 'active-run-follow-up'
          : currentState.activeRunId
            ? 'active-run-steer'
            : 'run-started')
      const acceptedUserMessage = 'userMessage' in accepted ? accepted.userMessage : null
      const acceptedReplacedMessageId =
        'replacedMessageId' in accepted ? accepted.replacedMessageId : undefined

      set((state) => ({
        activeRunId:
          acceptedKind === 'active-run-follow-up'
            ? state.activeRunId
            : (accepted.runId ?? state.activeRunId),
        activeRequestMessageId:
          acceptedKind === 'active-run-follow-up' || acceptedKind === 'active-run-steer-pending'
            ? state.activeRequestMessageId
            : (acceptedUserMessage?.id ?? state.activeRequestMessageId),
        activeRunThreadId:
          acceptedKind === 'active-run-follow-up' ? state.activeRunThreadId : accepted.thread.id,
        activeThreadId: accepted.thread.id,
        archivedThreads: removeThread(state.archivedThreads, accepted.thread.id),
        composerDrafts: removeComposerDraft(state.composerDrafts, accepted.thread.id),
        lastError: null,
        messages: {
          ...state.messages,
          [accepted.thread.id]:
            acceptedKind === 'active-run-steer-pending'
              ? (state.messages[accepted.thread.id] ?? [])
              : replaceMessage(
                  state.messages[accepted.thread.id] ?? [],
                  acceptedUserMessage as Message,
                  acceptedReplacedMessageId
                )
        },
        pendingSteerMessages:
          acceptedKind === 'active-run-steer-pending'
            ? {
                ...state.pendingSteerMessages,
                [accepted.thread.id]: {
                  content: trimmed,
                  createdAt: new Date().toISOString(),
                  ...(images.length > 0 ? { images } : {})
                }
              }
            : acceptedKind === 'active-run-steer'
              ? removePendingSteerMessage(state.pendingSteerMessages, accepted.thread.id)
              : state.pendingSteerMessages,
        runPhase:
          acceptedKind === 'active-run-follow-up' || acceptedKind === 'active-run-steer-pending'
            ? state.runPhase
            : 'preparing',
        runStatus:
          acceptedKind === 'active-run-follow-up' || acceptedKind === 'active-run-steer-pending'
            ? state.runStatus
            : 'running',
        threadListMode: 'active',
        threads: upsertThread(state.threads, accepted.thread)
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send the message.'
      set({
        activeThreadId: threadId,
        lastError: message,
        runStatus: 'failed'
      })
    }
  },

  setEnabledTools: async (enabledTools) => {
    const previousEnabledTools = get().enabledTools
    const nextEnabledTools = normalizeUserEnabledTools(enabledTools, previousEnabledTools)

    if (areEnabledToolsEqual(previousEnabledTools, nextEnabledTools)) {
      return
    }

    set((state) => ({
      config: state.config ? { ...state.config, enabledTools: nextEnabledTools } : state.config,
      enabledTools: nextEnabledTools,
      lastError: null
    }))

    try {
      const config = await window.api.yachiyo.saveToolPreferences({
        enabledTools: nextEnabledTools
      })
      set({
        config,
        enabledTools: normalizeUserEnabledTools(config.enabledTools, nextEnabledTools),
        lastError: null
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update tool availability.'
      set((state) => ({
        config: state.config
          ? { ...state.config, enabledTools: previousEnabledTools }
          : state.config,
        enabledTools: previousEnabledTools,
        lastError: message
      }))
      throw error
    }
  },

  setActiveThread: (id, scrollToMessageId) => {
    set({
      activeThreadId: id,
      threadListMode: 'active',
      scrollToMessageId: scrollToMessageId ?? null
    })
    void refreshAvailableSkills(set, get)
  },
  clearScrollToMessageId: () => set({ scrollToMessageId: null }),
  setComposerEnabledSkillNames: (enabledSkillNames) =>
    set((state) => {
      const draftKey = getComposerDraftKey(state.activeThreadId)
      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
          ...draft,
          enabledSkillNames: enabledSkillNames ? normalizeSkillNames(enabledSkillNames) : null
        }))
      }
    }),

  setActiveArchivedThread: (id) => set({ activeArchivedThreadId: id, threadListMode: 'archived' }),

  setThreadListMode: (mode) =>
    set((state) => ({
      activeArchivedThreadId:
        mode === 'archived'
          ? (state.activeArchivedThreadId ?? state.archivedThreads[0]?.id ?? null)
          : state.activeArchivedThreadId,
      activeThreadId:
        mode === 'active'
          ? (state.activeThreadId ?? state.threads[0]?.id ?? null)
          : state.activeThreadId,
      threadListMode: mode
    })),

  setComposerValue: (value) =>
    set((state) => {
      const draftKey = getComposerDraftKey(state.activeThreadId)

      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
          ...draft,
          text: value
        }))
      }
    }),

  setPendingWorkspacePath: (workspacePath) => {
    set({
      pendingWorkspacePath: normalizeWorkspacePath(workspacePath)
    })
    void refreshAvailableSkills(set, get)
  },

  setThreadWorkspace: async (workspacePath) => {
    const threadId = get().activeThreadId
    if (!threadId) {
      set({
        pendingWorkspacePath: normalizeWorkspacePath(workspacePath)
      })
      await refreshAvailableSkills(set, get)
      return
    }

    try {
      const thread = await window.api.yachiyo.updateThreadWorkspace({
        threadId,
        workspacePath: normalizeWorkspacePath(workspacePath)
      })
      set((state) => ({
        lastError: null,
        threads: upsertThread(state.threads, thread)
      }))
      await refreshAvailableSkills(set, get)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to change the workspace.'
      set({ lastError: message })
      throw error
    }
  },

  toggleEnabledTool: async (toolName) => {
    await get().setEnabledTools(toggleEnabledTools(get().enabledTools, toolName))
  },

  upsertComposerImage: (image, threadId) =>
    set((state) => {
      const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)
      const currentDraft = state.composerDrafts[draftKey] ?? EMPTY_COMPOSER_DRAFT
      const existingIndex = currentDraft.images.findIndex((entry) => entry.id === image.id)

      if (existingIndex === -1 && image.status !== 'loading') {
        return state
      }

      const images =
        existingIndex === -1
          ? [...currentDraft.images, image]
          : currentDraft.images.map((entry, index) => (index === existingIndex ? image : entry))

      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
          ...draft,
          images
        }))
      }
    })
}))
