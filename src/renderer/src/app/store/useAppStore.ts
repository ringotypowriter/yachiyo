import { create } from 'zustand'

import type {
  ConnectionStatus,
  Message,
  MessageImageRecord,
  MessageTextBlockRecord,
  ProviderSettings,
  RunRecord,
  RunStatus,
  SendChatAttachment,
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

export interface ComposerFileDraft {
  id: string
  filename: string
  mediaType: string
  dataUrl: string
  status: 'loading' | 'ready' | 'failed'
  error?: string
}

export interface ComposerDraft {
  text: string
  images: ComposerImageDraft[]
  files: ComposerFileDraft[]
  enabledSkillNames?: string[] | null
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: '',
  images: [],
  files: [],
  enabledSkillNames: null
}

export interface EditingMessageState {
  messageId: string
  threadId: string
  preEditDraft: ComposerDraft
}

export interface AppToast {
  id: string
  threadId: string
  title: string
  body: string
  eventKey: string
}

const NOTIFICATION_DEDUPE_WINDOW_MS = 10_000
const recentNotificationKeys = new Map<string, number>()

function shouldShowNotification(key: string): boolean {
  const now = Date.now()

  for (const [existingKey, timestamp] of recentNotificationKeys) {
    if (now - timestamp >= NOTIFICATION_DEDUPE_WINDOW_MS) {
      recentNotificationKeys.delete(existingKey)
    }
  }

  if (recentNotificationKeys.has(key)) {
    return false
  }

  recentNotificationKeys.set(key, now)
  return true
}

interface AppState {
  activeToasts: AppToast[]
  queuedToasts: AppToast[]
  pushToast: (toast: Omit<AppToast, 'id'>) => void
  dismissToast: (id: string) => void
  flushQueuedToasts: () => void

  activeArchivedThreadId: string | null
  activeRunId: string | null
  activeRunIdsByThread: Record<string, string>
  activeRequestMessageId: string | null
  activeRequestMessageIdsByThread: Record<string, string>
  activeRunThreadId: string | null
  activeThreadId: string | null
  archivedThreads: Thread[]
  archiveThread: (threadId: string) => Promise<void>
  availableSkills: SkillCatalogEntry[]
  cancelRunForThread: (threadId: string) => Promise<void>
  compactThreadToAnotherThread: () => Promise<void>
  composerDrafts: Record<string, ComposerDraft>
  createBranch: (messageId: string) => Promise<void>
  config: SettingsConfig | null
  connectionStatus: ConnectionStatus
  deleteThread: (threadId: string) => Promise<void>
  enabledTools: ToolCallName[]
  harnessEvents: Record<string, HarnessRecord[]>
  subagentActiveByThread: Record<string, boolean>
  subagentProgressByThread: Record<string, string>
  initialized: boolean
  isBootstrapping: boolean
  lastError: string | null
  latestRunsByThread: Record<string, RunRecord>
  runsByThread: Record<string, RunRecord[]>
  removeComposerImage: (imageId: string, threadId?: string | null) => void
  upsertComposerFile: (file: ComposerFileDraft, threadId?: string | null) => void
  removeComposerFile: (fileId: string, threadId?: string | null) => void
  deleteMessage: (messageId: string) => Promise<void>
  editingMessage: EditingMessageState | null
  beginEditMessage: (messageId: string) => void
  cancelEditMessage: () => void
  messages: Record<string, Message[]>
  pendingAssistantMessages: Record<string, PendingAssistantMessage>
  pendingSteerMessages: Record<string, PendingSteerMessage>
  pendingWorkspacePath: string | null
  regenerateThreadTitle: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  setThreadIcon: (threadId: string, icon: string | null) => Promise<void>
  starThread: (threadId: string, starred: boolean) => Promise<void>
  restoreThread: (threadId: string) => Promise<void>
  retryMessage: (messageId: string) => Promise<void>
  runPhasesByThread: Record<string, 'idle' | 'preparing' | 'streaming'>
  savingThreadIds: Set<string>
  saveThread: (threadId: string, options?: { archiveAfterSave?: boolean }) => Promise<void>
  selectReplyBranch: (messageId: string) => Promise<void>
  runPhase: 'idle' | 'preparing' | 'streaming'
  runStatus: RunStatus
  runStatusesByThread: Record<string, RunStatus>
  settings: ProviderSettings
  threads: Thread[]
  threadListMode: 'active' | 'archived'
  toolCalls: Record<string, ToolCall[]>

  applyServerEvent: (event: YachiyoServerEvent) => void
  cancelActiveRun: () => Promise<void>
  createNewThread: () => Promise<void>
  initialize: () => Promise<void>
  selectModel: (providerName: string, model: string) => Promise<void>
  clearThreadModelOverride: (threadId: string) => Promise<void>
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
  thinkingEnabled: true,
  apiKey: '',
  baseUrl: ''
}

export function getEffectiveModel(
  state: Pick<AppState, 'activeThreadId' | 'threads' | 'settings'>
): { providerName: string; model: string } {
  const thread = state.activeThreadId
    ? state.threads.find((t) => t.id === state.activeThreadId)
    : undefined
  const override = thread?.modelOverride
  if (override) return override
  return { providerName: state.settings.providerName, model: state.settings.model }
}

export function getThreadEffectiveModel(
  state: Pick<AppState, 'threads' | 'settings'>,
  threadId: string | null
): { providerName: string; model: string } {
  const thread = threadId ? state.threads.find((t) => t.id === threadId) : undefined
  const override = thread?.modelOverride
  if (override) return override
  return { providerName: state.settings.providerName, model: state.settings.model }
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

function getThreadActiveRunId(
  state: Pick<AppState, 'activeRunIdsByThread'>,
  threadId: string | null
): string | null {
  if (!threadId) {
    return null
  }

  return state.activeRunIdsByThread[threadId] ?? null
}

function getThreadActiveRequestMessageId(
  state: Pick<AppState, 'activeRequestMessageIdsByThread'>,
  threadId: string | null
): string | null {
  if (!threadId) {
    return null
  }

  return state.activeRequestMessageIdsByThread[threadId] ?? null
}

function getThreadRunPhase(
  state: Pick<AppState, 'runPhasesByThread'>,
  threadId: string | null
): AppState['runPhase'] {
  if (!threadId) {
    return 'idle'
  }

  return state.runPhasesByThread[threadId] ?? 'idle'
}

function getThreadRunStatus(
  state: Pick<AppState, 'runStatusesByThread'>,
  threadId: string | null
): RunStatus {
  if (!threadId) {
    return 'idle'
  }

  return state.runStatusesByThread[threadId] ?? 'idle'
}

function deriveActiveThreadRunState(
  state: Pick<
    AppState,
    | 'activeThreadId'
    | 'activeRunIdsByThread'
    | 'activeRequestMessageIdsByThread'
    | 'runPhasesByThread'
    | 'runStatusesByThread'
  >
): Pick<
  AppState,
  'activeRunId' | 'activeRequestMessageId' | 'activeRunThreadId' | 'runPhase' | 'runStatus'
> {
  const activeThreadId = state.activeThreadId
  const activeRunId = getThreadActiveRunId(state, activeThreadId)

  return {
    activeRunId,
    activeRequestMessageId: getThreadActiveRequestMessageId(state, activeThreadId),
    activeRunThreadId: activeRunId ? activeThreadId : null,
    runPhase: getThreadRunPhase(state, activeThreadId),
    runStatus: getThreadRunStatus(state, activeThreadId)
  }
}

function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.enabledSkillNames === null
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

function setThreadStringValue(
  values: Record<string, string>,
  threadId: string,
  value: string | null
): Record<string, string> {
  if (value === null) {
    if (!(threadId in values)) {
      return values
    }

    const next = { ...values }
    delete next[threadId]
    return next
  }

  return {
    ...values,
    [threadId]: value
  }
}

function setThreadRunPhaseValue(
  values: AppState['runPhasesByThread'],
  threadId: string,
  value: AppState['runPhase']
): AppState['runPhasesByThread'] {
  return {
    ...values,
    [threadId]: value
  }
}

function setThreadRunStatusValue(
  values: AppState['runStatusesByThread'],
  threadId: string,
  value: RunStatus
): AppState['runStatusesByThread'] {
  return {
    ...values,
    [threadId]: value
  }
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

function toReadyFileAttachments(files: ComposerFileDraft[]): SendChatAttachment[] {
  return files
    .filter((file) => file.status === 'ready' && file.dataUrl)
    .map((file) => ({
      filename: file.filename,
      mediaType: file.mediaType,
      dataUrl: file.dataUrl
    }))
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
  if (typeof window === 'undefined') {
    return
  }

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
  activeRunIdsByThread: {},
  activeRequestMessageId: null,
  savingThreadIds: new Set<string>(),
  activeRequestMessageIdsByThread: {},
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
      set((state) => {
        const nextState = {
          ...state,
          activeRunIdsByThread: {
            ...state.activeRunIdsByThread,
            [accepted.thread.id]: accepted.runId
          },
          activeThreadId: accepted.thread.id,
          lastError: null,
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            accepted.thread.id,
            'preparing'
          ),
          runStatusesByThread: setThreadRunStatusValue(
            state.runStatusesByThread,
            accepted.thread.id,
            'running'
          ),
          threadListMode: 'active' as const,
          messages: {
            ...state.messages,
            [accepted.thread.id]: state.messages[accepted.thread.id] ?? []
          },
          toolCalls: {
            ...state.toolCalls,
            [accepted.thread.id]: state.toolCalls[accepted.thread.id] ?? []
          },
          threads: upsertThread(state.threads, accepted.thread)
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
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
      set((state) => {
        const nextState = {
          ...state,
          activeThreadId: snapshot.thread.id,
          threadListMode: 'active' as const,
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
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
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
  subagentActiveByThread: {},
  subagentProgressByThread: {},
  initialized: false,
  isBootstrapping: false,
  lastError: null,
  latestRunsByThread: {},
  runsByThread: {},
  runPhasesByThread: {},
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
    set((state) => {
      const next = new Set(state.savingThreadIds)
      next.add(threadId)
      return { savingThreadIds: next }
    })
    try {
      await window.api.yachiyo.saveThread({
        threadId,
        archiveAfterSave: options.archiveAfterSave
      })
      set((state) => {
        const next = new Set(state.savingThreadIds)
        next.delete(threadId)
        return { savingThreadIds: next, lastError: null }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save this thread.'
      set((state) => {
        const next = new Set(state.savingThreadIds)
        next.delete(threadId)
        return { savingThreadIds: next, lastError: message }
      })
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
  editingMessage: null,
  beginEditMessage: (messageId) => {
    const state = get()
    const threadId = state.activeThreadId
    if (!threadId) return
    const message = (state.messages[threadId] ?? []).find((m) => m.id === messageId)
    if (!message) return
    const preEditDraft = state.composerDrafts[getComposerDraftKey(threadId)] ?? EMPTY_COMPOSER_DRAFT
    const imageDrafts: ComposerImageDraft[] = (message.images ?? []).map((img) => ({
      id: crypto.randomUUID(),
      status: 'ready' as const,
      dataUrl: img.dataUrl,
      mediaType: img.mediaType,
      filename: img.filename ?? undefined
    }))
    const fileDrafts: ComposerFileDraft[] = (message.attachments ?? []).map((attachment) => ({
      id: crypto.randomUUID(),
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      dataUrl: '',
      status: 'loading' as const
    }))
    set((s) => ({
      editingMessage: { messageId, threadId, preEditDraft },
      composerDrafts: updateComposerDraft(s.composerDrafts, getComposerDraftKey(threadId), () => ({
        text: message.content,
        images: imageDrafts,
        files: fileDrafts,
        enabledSkillNames: null
      }))
    }))
    if (fileDrafts.length > 0 && message.attachments) {
      const attachments = message.attachments
      for (let i = 0; i < fileDrafts.length; i++) {
        const draft = fileDrafts[i]
        const attachment = attachments[i]
        if (!draft || !attachment) continue
        window.api.yachiyo
          .readAttachmentFile({
            filePath: attachment.workspacePath,
            mediaType: attachment.mediaType
          })
          .then((dataUrl) => {
            if (get().editingMessage?.messageId !== messageId) return
            get().upsertComposerFile({ ...draft, dataUrl, status: 'ready' }, threadId)
          })
          .catch(() => {
            if (get().editingMessage?.messageId !== messageId) return
            get().upsertComposerFile(
              { ...draft, status: 'failed', error: 'Could not load attachment' },
              threadId
            )
          })
      }
    }
  },
  cancelEditMessage: () => {
    const state = get()
    const threadId = state.activeThreadId
    if (!state.editingMessage || !threadId) return
    const preEditDraft = state.editingMessage.preEditDraft
    set((s) => ({
      editingMessage: null,
      composerDrafts: updateComposerDraft(
        s.composerDrafts,
        getComposerDraftKey(threadId),
        () => preEditDraft
      )
    }))
  },
  activeToasts: [],
  queuedToasts: [],

  pushToast: (toast) =>
    set((state) => ({
      activeToasts: [...state.activeToasts, { ...toast, id: crypto.randomUUID() }]
    })),

  dismissToast: (id) =>
    set((state) => ({ activeToasts: state.activeToasts.filter((t) => t.id !== id) })),

  flushQueuedToasts: () =>
    set((state) => {
      if (state.queuedToasts.length === 0) return state
      const toFlush = state.queuedToasts.filter((t) => t.threadId !== state.activeThreadId)
      return { activeToasts: [...state.activeToasts, ...toFlush], queuedToasts: [] }
    }),

  runPhase: 'idle',
  runStatus: 'idle',
  runStatusesByThread: {},
  settings: DEFAULT_SETTINGS,
  threads: [],
  threadListMode: 'active',
  toolCalls: {},

  applyServerEvent: (event) => {
    const notifyActivity = (key: string, threadId: string, title: string, body: string): void => {
      if (!shouldShowNotification(key)) return

      const { activeThreadId } = get()
      const isForeground = !document.hidden && document.hasFocus()

      if (isForeground) {
        if (threadId !== activeThreadId) {
          set((s) => ({
            activeToasts: [
              ...s.activeToasts,
              { id: crypto.randomUUID(), threadId, title, body, eventKey: key }
            ]
          }))
        }
      } else {
        window.api.yachiyo.showNotification({ title, body })
        set((s) => ({
          queuedToasts: [
            ...s.queuedToasts,
            { id: crypto.randomUUID(), threadId, title, body, eventKey: key }
          ]
        }))
      }
    }

    if (event.type === 'run.completed') {
      const { config, threads, messages } = get()
      if (config?.general?.notifyRunCompleted !== false) {
        const thread = threads.find((t) => t.id === event.threadId)
        const threadMessages = messages[event.threadId] ?? []
        const lastAssistantMessage = [...threadMessages]
          .reverse()
          .find((m) => m.role === 'assistant')
        const lastTextBlock = lastAssistantMessage?.textBlocks?.at(-1)
        const preview =
          lastTextBlock?.content.trim().slice(0, 60) ??
          lastAssistantMessage?.content.trim().slice(0, 60) ??
          'Run completed'
        notifyActivity(
          `run.completed:${event.runId}`,
          event.threadId,
          thread?.title ?? 'Yachiyo',
          preview
        )
      }
    }

    if (event.type === 'subagent.started') {
      const { config, threads } = get()
      if (config?.general?.notifyCodingTaskStarted !== false) {
        const thread = threads.find((t) => t.id === event.threadId)
        notifyActivity(
          `subagent.started:${event.runId}:${event.agentName}`,
          event.threadId,
          thread?.title ?? 'Yachiyo',
          `${event.agentName} dispatched`
        )
      }
    }

    if (event.type === 'subagent.finished') {
      const { config, threads } = get()
      if (config?.general?.notifyCodingTaskFinished !== false) {
        const thread = threads.find((t) => t.id === event.threadId)
        notifyActivity(
          `subagent.finished:${event.runId}:${event.agentName}:${event.status}`,
          event.threadId,
          thread?.title ?? 'Yachiyo',
          event.status === 'cancelled'
            ? `${event.agentName} cancelled`
            : `${event.agentName} finished`
        )
      }
    }

    set((state) => {
      if (event.type === 'thread.archived') {
        const threads = removeThread(state.threads, event.threadId)
        const archivedThreads = upsertThread(state.archivedThreads, event.thread)
        const nextState = {
          ...state,
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

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'thread.restored') {
        const archivedThreads = removeThread(state.archivedThreads, event.threadId)
        const threads = upsertThread(state.threads, event.thread)
        const nextState = {
          ...state,
          activeArchivedThreadId:
            state.activeArchivedThreadId === event.threadId
              ? (archivedThreads[0]?.id ?? null)
              : state.activeArchivedThreadId,
          activeThreadId: event.thread.id,
          archivedThreads,
          threadListMode: 'active' as const,
          threads
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'thread.deleted') {
        const activeRunIdsByThread = { ...state.activeRunIdsByThread }
        delete activeRunIdsByThread[event.threadId]
        const activeRequestMessageIdsByThread = { ...state.activeRequestMessageIdsByThread }
        delete activeRequestMessageIdsByThread[event.threadId]
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
        const runPhasesByThread = { ...state.runPhasesByThread }
        delete runPhasesByThread[event.threadId]
        const runStatusesByThread = { ...state.runStatusesByThread }
        delete runStatusesByThread[event.threadId]
        const toolCalls = { ...state.toolCalls }
        delete toolCalls[event.threadId]
        const subagentActiveByThread = { ...state.subagentActiveByThread }
        delete subagentActiveByThread[event.threadId]
        const subagentProgressByThread = { ...state.subagentProgressByThread }
        delete subagentProgressByThread[event.threadId]

        const activeThreadId =
          state.activeThreadId === event.threadId ? (threads[0]?.id ?? null) : state.activeThreadId
        const nextState = {
          ...state,
          activeArchivedThreadId:
            state.activeArchivedThreadId === event.threadId
              ? (archivedThreads[0]?.id ?? null)
              : state.activeArchivedThreadId,
          activeRequestMessageIdsByThread,
          activeRunIdsByThread,
          activeThreadId,
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
          runPhasesByThread,
          runStatusesByThread,
          subagentActiveByThread,
          subagentProgressByThread,
          toolCalls,
          threads
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'thread.created' || event.type === 'thread.updated') {
        const nextActiveRequestMessageId = state.activeRunIdsByThread[event.threadId]
          ? resolveActiveRequestMessageId(
              event.thread,
              state.messages[event.threadId] ?? [],
              state.activeRequestMessageIdsByThread[event.threadId] ?? null
            )
          : (state.activeRequestMessageIdsByThread[event.threadId] ?? null)
        const shouldClearPendingSteer =
          Boolean(state.pendingSteerMessages[event.threadId]) &&
          Boolean(state.activeRunIdsByThread[event.threadId]) &&
          Boolean(event.thread.headMessageId) &&
          event.thread.headMessageId !==
            (state.activeRequestMessageIdsByThread[event.threadId] ?? null)

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread: setThreadStringValue(
            state.activeRequestMessageIdsByThread,
            event.threadId,
            nextActiveRequestMessageId
          ),
          archivedThreads: removeThread(state.archivedThreads, event.threadId),
          pendingSteerMessages: shouldClearPendingSteer
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          threads: upsertThread(state.threads, event.thread)
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'thread.state.replaced') {
        const nextActiveRequestMessageId = state.activeRunIdsByThread[event.threadId]
          ? resolveActiveRequestMessageId(
              event.thread,
              event.messages,
              state.activeRequestMessageIdsByThread[event.threadId] ?? null
            )
          : (state.activeRequestMessageIdsByThread[event.threadId] ?? null)

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread: setThreadStringValue(
            state.activeRequestMessageIdsByThread,
            event.threadId,
            nextActiveRequestMessageId
          ),
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

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
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
        const nextState = {
          ...state,
          activeRequestMessageIdsByThread: event.requestMessageId
            ? {
                ...state.activeRequestMessageIdsByThread,
                [event.threadId]: event.requestMessageId
              }
            : state.activeRequestMessageIdsByThread,
          activeRunIdsByThread: {
            ...state.activeRunIdsByThread,
            [event.threadId]: event.runId
          },
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
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            event.threadId,
            'preparing'
          ),
          runStatusesByThread: setThreadRunStatusValue(
            state.runStatusesByThread,
            event.threadId,
            'running'
          )
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
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

      if (event.type === 'message.reasoning.delta') {
        const pending = state.pendingAssistantMessages[event.runId]
        if (!pending) return {}

        const nextThreadMessages = (state.messages[event.threadId] ?? []).map((message) =>
          message.id === pending.messageId
            ? { ...message, reasoning: (message.reasoning ?? '') + event.delta }
            : message
        )

        return {
          messages: { ...state.messages, [event.threadId]: nextThreadMessages }
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

        const nextState = {
          ...state,
          messages: {
            ...state.messages,
            [event.threadId]: nextThreadMessages
          },
          pendingAssistantMessages: {
            ...state.pendingAssistantMessages,
            [event.runId]: nextPendingAssistantMessage
          },
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            event.threadId,
            'streaming'
          )
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
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
        const activeRunIdsByThread = { ...state.activeRunIdsByThread }
        delete activeRunIdsByThread[event.threadId]
        const activeRequestMessageIdsByThread = { ...state.activeRequestMessageIdsByThread }
        delete activeRequestMessageIdsByThread[event.threadId]
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread,
          activeRunIdsByThread,
          latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
            id: event.runId,
            threadId: event.threadId,
            status: 'completed',
            createdAt: existingLatestRun?.createdAt ?? event.timestamp,
            requestMessageId: existingLatestRun?.requestMessageId,
            recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
            recallDecision: existingLatestRun?.recallDecision,
            contextSources: existingLatestRun?.contextSources,
            completedAt: event.timestamp,
            ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
            ...(event.completionTokens !== undefined
              ? { completionTokens: event.completionTokens }
              : {}),
            ...(event.totalPromptTokens !== undefined
              ? { totalPromptTokens: event.totalPromptTokens }
              : {}),
            ...(event.totalCompletionTokens !== undefined
              ? { totalCompletionTokens: event.totalCompletionTokens }
              : {})
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
            completedAt: event.timestamp,
            ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
            ...(event.completionTokens !== undefined
              ? { completionTokens: event.completionTokens }
              : {}),
            ...(event.totalPromptTokens !== undefined
              ? { totalPromptTokens: event.totalPromptTokens }
              : {}),
            ...(event.totalCompletionTokens !== undefined
              ? { totalCompletionTokens: event.totalCompletionTokens }
              : {})
          })),
          pendingAssistantMessages,
          pendingSteerMessages: state.activeRunIdsByThread[event.threadId]
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            event.threadId,
            'idle'
          ),
          runStatusesByThread: setThreadRunStatusValue(
            state.runStatusesByThread,
            event.threadId,
            'idle'
          )
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'run.failed') {
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const activeRunIdsByThread = { ...state.activeRunIdsByThread }
        delete activeRunIdsByThread[event.threadId]
        const activeRequestMessageIdsByThread = { ...state.activeRequestMessageIdsByThread }
        delete activeRequestMessageIdsByThread[event.threadId]
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread,
          activeRunIdsByThread,
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
          pendingSteerMessages: state.activeRunIdsByThread[event.threadId]
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            event.threadId,
            'idle'
          ),
          runStatusesByThread: setThreadRunStatusValue(
            state.runStatusesByThread,
            event.threadId,
            'failed'
          )
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'run.cancelled') {
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const activeRunIdsByThread = { ...state.activeRunIdsByThread }
        delete activeRunIdsByThread[event.threadId]
        const activeRequestMessageIdsByThread = { ...state.activeRequestMessageIdsByThread }
        delete activeRequestMessageIdsByThread[event.threadId]
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread,
          activeRunIdsByThread,
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
          pendingSteerMessages: state.activeRunIdsByThread[event.threadId]
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            event.threadId,
            'idle'
          ),
          runStatusesByThread: setThreadRunStatusValue(
            state.runStatusesByThread,
            event.threadId,
            'cancelled'
          )
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
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

      if (event.type === 'subagent.started') {
        return {
          subagentActiveByThread: { ...state.subagentActiveByThread, [event.threadId]: true },
          subagentProgressByThread: { ...state.subagentProgressByThread, [event.threadId]: '' }
        }
      }

      if (event.type === 'subagent.progress') {
        const prev = state.subagentProgressByThread[event.threadId] ?? ''
        return {
          subagentProgressByThread: {
            ...state.subagentProgressByThread,
            [event.threadId]: prev + event.chunk
          }
        }
      }

      if (event.type === 'subagent.finished') {
        const next = { ...state.subagentActiveByThread }
        delete next[event.threadId]
        return { subagentActiveByThread: next }
      }

      return {}
    })
  },

  cancelActiveRun: async () => {
    const activeThreadId = get().activeThreadId
    if (!activeThreadId) return
    await get().cancelRunForThread(activeThreadId)
  },

  cancelRunForThread: async (threadId) => {
    const runId = get().activeRunIdsByThread[threadId]
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
      set((state) => {
        const nextState = {
          ...state,
          activeThreadId: reusableThread.id,
          pendingWorkspacePath: null,
          threadListMode: 'active' as const
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
      await refreshAvailableSkills(set, get)
      return
    }

    const thread = await window.api.yachiyo.createThread(
      pendingWorkspacePath ? { workspacePath: pendingWorkspacePath } : undefined
    )
    set((state) => {
      const nextState = {
        ...state,
        activeArchivedThreadId: state.activeArchivedThreadId,
        activeThreadId: thread.id,
        composerDrafts: removeComposerDraft(state.composerDrafts, null),
        pendingWorkspacePath: null,
        threadListMode: 'active' as const,
        messages: {
          ...state.messages,
          [thread.id]: state.messages[thread.id] ?? []
        },
        toolCalls: {
          ...state.toolCalls,
          [thread.id]: state.toolCalls[thread.id] ?? []
        },
        threads: upsertThread(state.threads, thread)
      }

      return {
        ...nextState,
        ...deriveActiveThreadRunState(nextState)
      }
    })
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
        const recoveredSaveToasts = payload.recoveredInterruptedSaveThreadIds.map((threadId) => {
          const thread = [...payload.threads, ...payload.archivedThreads].find(
            (item) => item.id === threadId
          )
          return {
            id: crypto.randomUUID(),
            threadId,
            title: thread?.title ?? 'Thread save interrupted',
            body: 'Save Thread was interrupted before completion. The thread stays unarchived and is available again.',
            eventKey: `thread.save.recovered:${threadId}`
          }
        })
        set((state) => ({
          activeThreadId: state.activeThreadId ?? payload.threads[0]?.id ?? null,
          activeArchivedThreadId:
            state.activeArchivedThreadId ?? payload.archivedThreads[0]?.id ?? null,
          activeToasts: [...state.activeToasts, ...recoveredSaveToasts],
          archivedThreads: sortThreads(payload.archivedThreads),
          config: payload.config ?? state.config,
          connectionStatus: 'connected',
          enabledTools: normalizeUserEnabledTools(payload.config?.enabledTools, state.enabledTools),
          initialized: true,
          isBootstrapping: false,
          lastError: null,
          latestRunsByThread: payload.latestRunsByThread,
          runsByThread: bootstrapRunsByThread(payload.latestRunsByThread),
          runPhasesByThread: Object.fromEntries(
            Object.keys(payload.latestRunsByThread).map((threadId) => [threadId, 'idle'] as const)
          ),
          runStatusesByThread: Object.fromEntries(
            Object.entries(payload.latestRunsByThread).map(([threadId, run]) => [
              threadId,
              run.status === 'running' ? 'running' : 'idle'
            ])
          ),
          messages: payload.messagesByThread,
          settings: payload.settings ?? state.settings ?? DEFAULT_SETTINGS,
          threads: sortThreads(payload.threads),
          toolCalls: payload.toolCallsByThread
        }))
        set((state) => deriveActiveThreadRunState(state))
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

  regenerateThreadTitle: async (threadId) => {
    await window.api.yachiyo.regenerateThreadTitle({ threadId })
  },

  renameThread: async (threadId, title) => {
    await window.api.yachiyo.renameThread({ threadId, title })
  },

  setThreadIcon: async (threadId, icon) => {
    await window.api.yachiyo.setThreadIcon({ threadId, icon })
  },

  starThread: async (threadId, starred) => {
    await window.api.yachiyo.starThread({ threadId, starred })
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
      set((state) => {
        const nextState = {
          ...state,
          activeRequestMessageIdsByThread: setThreadStringValue(
            state.activeRequestMessageIdsByThread,
            accepted.thread.id,
            accepted.requestMessageId
          ),
          activeRunIdsByThread: {
            ...state.activeRunIdsByThread,
            [accepted.thread.id]: accepted.runId
          },
          activeThreadId: accepted.thread.id,
          lastError: null,
          runPhasesByThread: setThreadRunPhaseValue(
            state.runPhasesByThread,
            accepted.thread.id,
            'preparing'
          ),
          runStatusesByThread: setThreadRunStatusValue(
            state.runStatusesByThread,
            accepted.thread.id,
            'running'
          ),
          threadListMode: 'active' as const,
          threads: upsertThread(state.threads, accepted.thread)
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
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
    const state = get()
    if (
      getThreadRunPhase(state, state.activeThreadId) !== 'idle' ||
      getThreadRunStatus(state, state.activeThreadId) === 'running'
    ) {
      return
    }

    if (state.activeThreadId) {
      const updatedThread = await window.api.yachiyo.setThreadModelOverride({
        threadId: state.activeThreadId,
        modelOverride: { providerName, model }
      })
      set((s) => ({ threads: upsertThread(s.threads, updatedThread) }))
    } else {
      await window.api.yachiyo.saveSettings({ providerName, model })
    }
  },

  clearThreadModelOverride: async (threadId) => {
    const updatedThread = await window.api.yachiyo.setThreadModelOverride({
      threadId,
      modelOverride: null
    })
    set((s) => ({ threads: upsertThread(s.threads, updatedThread) }))
  },

  sendMessage: async (mode = 'normal') => {
    const currentState = get()
    const draft = getComposerDraft(currentState)
    const trimmed = draft.text.trim()
    const images = toReadyMessageImages(draft.images)
    const attachments = toReadyFileAttachments(draft.files)
    const enabledTools = currentState.enabledTools
    const enabledSkillNames = resolveEffectiveEnabledSkillNames({
      config: currentState.config,
      draft
    })

    if (
      draft.images.some((image) => image.status === 'loading' || image.status === 'failed') ||
      draft.files.some((file) => file.status === 'loading' || file.status === 'failed') ||
      !hasMessagePayload({ content: trimmed, images, attachments })
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
        threadListMode: 'active' as const,
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

    const editingMessage = currentState.editingMessage
    const isEditMode =
      mode === 'normal' && editingMessage !== null && editingMessage.threadId === threadId

    try {
      const accepted = isEditMode
        ? await window.api.yachiyo.editMessage({
            threadId,
            messageId: editingMessage.messageId,
            content: trimmed,
            enabledTools,
            enabledSkillNames: draft.enabledSkillNames !== null ? enabledSkillNames : undefined,
            ...(images.length > 0 ? { images } : {}),
            ...(attachments.length > 0 ? { attachments } : {})
          })
        : await window.api.yachiyo.sendChat({
            content: trimmed,
            enabledTools,
            enabledSkillNames:
              mode === 'follow-up' || draft.enabledSkillNames !== null
                ? enabledSkillNames
                : undefined,
            ...(images.length > 0 ? { images } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(mode !== 'normal' ? { mode } : {}),
            threadId
          })

      const threadActiveRunId = getThreadActiveRunId(currentState, threadId)
      const acceptedKind =
        accepted.kind ??
        (mode === 'follow-up'
          ? 'active-run-follow-up'
          : threadActiveRunId
            ? 'active-run-steer'
            : 'run-started')
      const acceptedUserMessage = 'userMessage' in accepted ? accepted.userMessage : null
      const acceptedReplacedMessageId =
        'replacedMessageId' in accepted ? accepted.replacedMessageId : undefined

      set((state) => {
        const nextActiveRequestMessageIdsByThread =
          acceptedKind !== 'active-run-follow-up' && acceptedKind !== 'active-run-steer-pending'
            ? setThreadStringValue(
                state.activeRequestMessageIdsByThread,
                accepted.thread.id,
                acceptedUserMessage?.id ?? null
              )
            : state.activeRequestMessageIdsByThread

        const nextActiveRunIdsByThread = { ...state.activeRunIdsByThread }
        if (acceptedKind !== 'active-run-follow-up' && accepted.runId) {
          nextActiveRunIdsByThread[accepted.thread.id] = accepted.runId
        }

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread: nextActiveRequestMessageIdsByThread,
          activeRunIdsByThread: nextActiveRunIdsByThread,
          activeThreadId: accepted.thread.id,
          archivedThreads: removeThread(state.archivedThreads, accepted.thread.id),
          composerDrafts: removeComposerDraft(state.composerDrafts, accepted.thread.id),
          editingMessage: null,
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
          runPhasesByThread:
            acceptedKind === 'active-run-follow-up' || acceptedKind === 'active-run-steer-pending'
              ? state.runPhasesByThread
              : setThreadRunPhaseValue(state.runPhasesByThread, accepted.thread.id, 'preparing'),
          runStatusesByThread:
            acceptedKind === 'active-run-follow-up' || acceptedKind === 'active-run-steer-pending'
              ? state.runStatusesByThread
              : setThreadRunStatusValue(state.runStatusesByThread, accepted.thread.id, 'running'),
          threadListMode: 'active' as const,
          threads: upsertThread(state.threads, accepted.thread)
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
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
    set((state) => {
      const nextState = {
        ...state,
        activeThreadId: id,
        editingMessage: state.editingMessage?.threadId === id ? state.editingMessage : null,
        threadListMode: 'active' as const,
        scrollToMessageId: scrollToMessageId ?? null
      }

      return {
        ...nextState,
        ...deriveActiveThreadRunState(nextState)
      }
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
    }),

  upsertComposerFile: (file, threadId) =>
    set((state) => {
      const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)
      const currentDraft = state.composerDrafts[draftKey] ?? EMPTY_COMPOSER_DRAFT
      const existingIndex = currentDraft.files.findIndex((entry) => entry.id === file.id)

      if (existingIndex === -1 && file.status !== 'loading') {
        return state
      }

      const files =
        existingIndex === -1
          ? [...currentDraft.files, file]
          : currentDraft.files.map((entry, index) => (index === existingIndex ? file : entry))

      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
          ...draft,
          files
        }))
      }
    }),

  removeComposerFile: (fileId, threadId) =>
    set((state) => {
      const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)

      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
          ...draft,
          files: draft.files.filter((file) => file.id !== fileId)
        }))
      }
    })
}))
