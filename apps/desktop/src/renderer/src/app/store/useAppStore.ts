import { create } from 'zustand'

import type {
  ConnectionStatus,
  ComposerReasoningSelection,
  FolderRecord,
  Message,
  MessageImageRecord,
  ProviderSettings,
  RunRecord,
  RunStatus,
  SendChatAttachment,
  SendChatMode,
  SettingsConfig,
  SkillCatalogEntry,
  Thread,
  ThreadColorTag,
  ThingRecord,
  ThreadModelOverride,
  ThreadSentinelRecord,
  TodoItemRecord,
  ToolCallName,
  ToolCall,
  YachiyoServerEvent
} from '../types.ts'
import {
  DEFAULT_ENABLED_TOOL_NAMES,
  DEFAULT_RUN_MODE_ID,
  type AcceptThreadPlanDocumentMode,
  type NotificationThreadTarget,
  type RunModeId,
  type SendChatRunTrigger,
  type ThreadRuntimeBinding
} from '@yachiyo/shared/protocol'
import { isPlanModeExitRecord, PLAN_MODE_EXIT_TOOL_NAME } from '@yachiyo/shared/planMode'
import {
  canCompactThreadToAnotherThread,
  isOwnerDmThread,
  isExternalThread
} from '../../features/threads/lib/threadVisibility.ts'
import { useBackgroundTasksStore } from '../../features/chat/state/useBackgroundTasksStore.ts'
import {
  DEFAULT_SETTINGS,
  DEFAULT_GLOBAL_PROCESSING_LABEL,
  DEFAULT_SIDEBAR_FILTER,
  EMPTY_COMPOSER_DRAFT,
  clearRecapForThread,
  createGlobalProcessingTask,
  deriveActiveThreadRunState,
  deriveSubagentStateFromToolCalls,
  deriveThreadListMode,
  findThread,
  getComposerDraftKey,
  getComposerReasoningEffort,
  getComposerToolMode,
  getEffectiveModel,
  getThreadEffectiveModel,
  hasActiveMultiFilter,
  loadCollapsedFolderIds,
  loadSidebarFilter,
  removePendingSteerMessage,
  replaceMessage,
  setThreadRunPhaseValue,
  setThreadRunStatusValue,
  shouldShowNotification,
  stripLatestRunTokens,
  updateComposerDraft,
  updateRunRecord,
  upsertThread,
  waitForGlobalProcessingPaint,
  withFilterBase
} from './useAppStore/helpers.ts'
import { createComposerUiActions } from './useAppStore/composerUiActions.ts'
import { reduceServerEvent } from './useAppStore/serverEventReducer.ts'
import { createSendMessageActions } from './useAppStore/sendMessageActions.ts'
import { createThreadLifecycleActions } from './useAppStore/threadLifecycleActions.ts'

export {
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_FILTER,
  EMPTY_COMPOSER_DRAFT,
  findThread,
  getComposerReasoningEffort,
  getComposerToolMode,
  getEffectiveModel,
  getThreadEffectiveModel,
  hasActiveMultiFilter
}

function shouldSuppressOwnerDmChannelNotification(
  thread: Thread,
  event: { runTrigger?: SendChatRunTrigger }
): boolean {
  return event.runTrigger === 'channel' && isOwnerDmThread(thread)
}

const MAX_SNAPSHOT_REVIEW_ENTRIES = 100

function withSnapshotReviewLimit(
  entries: AppState['snapshotReviewByRun']
): AppState['snapshotReviewByRun'] {
  const allEntries = Object.entries(entries)
  if (allEntries.length <= MAX_SNAPSHOT_REVIEW_ENTRIES) return entries
  return Object.fromEntries(allEntries.slice(allEntries.length - MAX_SNAPSHOT_REVIEW_ENTRIES))
}

export interface SidebarFilter {
  base: 'all' | 'archived'
  colorTags: Set<ThreadColorTag>
  workspacePaths: Set<string>
  running: boolean
  justDone: boolean
  folderOnly: boolean
}

export interface PendingAssistantMessage {
  messageId: string
  threadId: string
  parentMessageId?: string
  shouldStartNewTextBlock: boolean
}

export interface PendingSteerSegment {
  content: string
  images?: MessageImageRecord[]
  files?: ComposerFileDraft[]
  enabledSkillNames?: string[] | null
}

export interface PendingSteerMessage {
  segments: PendingSteerSegment[]
  /** Flattened content for display — kept in sync with segments. */
  content: string
  createdAt: string
  images?: MessageImageRecord[]
  files?: ComposerFileDraft[]
}

export interface ActiveSubagentState {
  delegationId: string
  threadId: string
  agentName: string
  agentType?: string
  progress: string
  workspacePath?: string
  startedAt?: string
  prompt?: string
  codeName?: string
  recentToolCalls?: Array<{
    toolCallId?: string
    toolName: string
    inputSummary: string
    outputSummary?: string
    status?: 'running' | 'completed' | 'failed'
  }>
}

export interface SubagentFinishedResult {
  delegationId: string
  agentName: string
  codeName?: string
  prompt?: string
  lastMessage?: string
  status: 'success' | 'cancelled'
  durationMs?: number
  promptTokens?: number
  completionTokens?: number
  finishedAt: string
}

export interface SubagentProgressEntry {
  delegationId: string
  agentName: string
  agentType?: string
  chunk: string
}

export interface SendMessageOverride {
  content: string
  images: MessageImageRecord[]
  attachments: SendChatAttachment[]
  enabledSkillNames?: string[] | null
  reasoningEffort?: ComposerReasoningSelection
  // Required: explicit target thread. Overrides activeThreadId resolution
  // and skips new-thread creation. Callers that need new-thread semantics
  // must route through the normal draft-based send path instead.
  threadId: string
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

export interface GlobalProcessingTask {
  id: string
  label: string
}

export interface TodoListState {
  items: TodoItemRecord[]
  updatedAt: string
}

export interface PlanDocumentState {
  path: string
  content: string
  updatedAt: string
  decision?: 'pending' | 'rejected' | 'accepted'
}

export interface AppState {
  activeToasts: AppToast[]
  queuedToasts: AppToast[]
  pushToast: (toast: Omit<AppToast, 'id'>) => void
  dismissToast: (id: string) => void
  flushQueuedToasts: () => void
  globalProcessingTasks: GlobalProcessingTask[]
  beginGlobalProcessing: (label?: string) => string
  endGlobalProcessing: (taskId: string) => void

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
  acceptPlanDocument: (threadId: string, mode: AcceptThreadPlanDocumentMode) => Promise<void>
  rejectPlanDocument: (threadId: string) => Promise<void>
  composerDrafts: Record<string, ComposerDraft>
  reasoningEffortByThread: Record<string, ComposerReasoningSelection>
  toolModeByThread: Record<string, { enabledTools: ToolCallName[]; runMode: RunModeId }>
  createBranch: (messageId: string) => Promise<void>
  config: SettingsConfig | null
  connectionStatus: ConnectionStatus
  deleteThread: (threadId: string) => Promise<void>
  enabledTools: ToolCallName[]
  runMode: RunModeId
  subagentActiveIdsByThread: Record<string, string[]>
  subagentProgressTimelineByThread: Record<string, SubagentProgressEntry[]>
  subagentStateById: Record<string, ActiveSubagentState>
  subagentFinishedResultsByThread: Record<string, SubagentFinishedResult[]>
  initialized: boolean
  isBootstrapping: boolean
  justDoneRunIdsByThread: Record<string, string>
  lastError: string | null
  latestRunsByThread: Record<string, RunRecord>
  runsByThread: Record<string, RunRecord[]>
  removeComposerImage: (imageId: string, threadId?: string | null) => void
  upsertComposerFile: (file: ComposerFileDraft, threadId?: string | null) => void
  removeComposerFile: (fileId: string, threadId?: string | null) => void
  deleteMessage: (messageId: string) => Promise<void>
  revertPendingSteer: () => Promise<void>
  revertQueuedFollowUp: (messageId: string) => Promise<void>
  editingMessage: EditingMessageState | null
  beginEditMessage: (messageId: string) => void
  cancelEditMessage: () => void
  messages: Record<string, Message[]>
  pendingAssistantMessages: Record<string, PendingAssistantMessage>
  pendingSteerMessages: Record<string, PendingSteerMessage>
  activeEssentialId: string | null
  pendingModelOverride: ThreadModelOverride | null
  pendingAcpBinding: ThreadRuntimeBinding | null
  pendingWorkspacePath: string | null
  regenerateThreadTitle: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  setThreadColor: (threadId: string, colorTag: ThreadColorTag | null) => Promise<void>
  setThreadIcon: (threadId: string, icon: string | null) => Promise<void>
  starThread: (threadId: string, starred: boolean) => Promise<void>
  createFolderForThreads: (threadIds: string[]) => Promise<void>
  renameFolder: (folderId: string, title: string) => Promise<void>
  setFolderColor: (folderId: string, colorTag: string | null) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  moveThreadToFolder: (threadId: string, folderId: string | null) => Promise<void>
  toggleFolderCollapsed: (folderId: string) => void
  restoreThread: (threadId: string) => Promise<void>
  retryMessage: (messageId: string) => Promise<void>
  retryInfoByThread: Record<string, { attempt: number; maxAttempts: number; error: string }>
  runPhasesByThread: Record<string, 'idle' | 'preparing' | 'streaming'>
  receivingModelOutputByThread: Record<string, boolean>
  savingThreadIds: Set<string>
  saveThread: (threadId: string, options?: { archiveAfterSave?: boolean }) => Promise<void>
  selectReplyBranch: (messageId: string) => Promise<void>
  runPhase: 'idle' | 'preparing' | 'streaming'
  runStatus: RunStatus
  runStatusesByThread: Record<string, RunStatus>
  settings: ProviderSettings
  threads: Thread[]
  things: ThingRecord[]
  showInactiveThings: boolean
  loadThings: (input?: { includeInactive?: boolean }) => Promise<void>
  reactivateThing: (name: string) => Promise<void>
  deleteThing: (name: string) => Promise<void>
  continueThingInNewChat: (name: string) => Promise<void>
  toggleShowInactiveThings: () => void
  folders: FolderRecord[]
  collapsedFolderIds: Set<string>
  externalThreads: Thread[]
  showExternalThreads: boolean
  threadListMode: 'active' | 'archived'
  sidebarFilter: SidebarFilter
  setSidebarFilterBase: (base: 'all' | 'archived') => void
  toggleSidebarFilterColor: (colorTag: ThreadColorTag) => void
  toggleSidebarFilterWorkspace: (workspacePath: string) => void
  toggleSidebarFilterRunning: () => void
  toggleSidebarFilterJustDone: () => void
  toggleSidebarFilterFolderOnly: () => void
  clearSidebarFilter: () => void
  todoListsByThread: Record<string, TodoListState>
  sentinelsByThread: Record<string, ThreadSentinelRecord>
  planDocumentsByThread: Record<string, PlanDocumentState>
  toolCalls: Record<string, ToolCall[]>
  /** Snapshot review info per run, set by snapshot.ready events. */
  snapshotReviewByRun: Record<
    string,
    { threadId: string; fileCount: number; workspacePath: string }
  >
  clearSnapshotReview: (runId: string) => void
  updateSnapshotFileCount: (threadId: string, runId: string, fileCount: number) => void

  applyServerEvent: (event: YachiyoServerEvent) => void
  cancelActiveRun: () => Promise<void>
  createNewThread: () => Promise<void>
  createNewThreadFromEssential: (essentialId: string) => void
  initialize: () => Promise<void>
  selectModel: (providerName: string, model: string) => Promise<void>
  clearThreadModelOverride: (threadId: string) => Promise<void>
  sendMessage: (mode?: SendChatMode, override?: SendMessageOverride) => Promise<boolean>
  mergeBufferedPayloadIntoDraft: (
    payload: {
      content: string
      images: MessageImageRecord[]
      attachments: SendChatAttachment[]
      enabledSkillNames: string[] | null | undefined
    },
    targetThreadId?: string | null
  ) => void
  setEnabledTools: (enabledTools: ToolCallName[]) => Promise<void>
  setRunMode: (runMode: RunModeId) => Promise<void>
  recapByThread: Record<string, string>
  scrollToMessageId: string | null
  setScrollToMessageId: (messageId: string) => void
  clearScrollToMessageId: () => void
  setActiveThread: (id: string, scrollToMessageId?: string) => void
  setActiveArchivedThread: (id: string, scrollToMessageId?: string) => void
  openThreadFromNotification: (id: string, target?: NotificationThreadTarget) => void
  setComposerValue: (value: string) => void
  setComposerEnabledSkillNames: (enabledSkillNames: string[] | null) => void
  setComposerReasoningEffort: (reasoningEffort: ComposerReasoningSelection) => void
  setPendingWorkspacePath: (workspacePath: string | null) => void
  setPendingAcpBinding: (binding: ThreadRuntimeBinding | null) => void
  setThreadWorkspace: (
    workspacePath: string | null,
    threadId?: string | null,
    options?: { confirmed?: boolean }
  ) => Promise<void>
  setThreadListMode: (mode: 'active' | 'archived') => void
  toggleShowExternalThreads: () => void
  setThreadPrivacyMode: (threadId: string, enabled: boolean) => Promise<void>
  toggleEnabledTool: (toolName: ToolCallName) => Promise<void>
  upsertComposerImage: (image: ComposerImageDraft, threadId?: string | null) => void
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
  recapByThread: {},
  scrollToMessageId: null,
  archivedThreads: [],
  folders: [],
  globalProcessingTasks: [],
  beginGlobalProcessing: (label = DEFAULT_GLOBAL_PROCESSING_LABEL) => {
    const task = createGlobalProcessingTask(label)
    set((state) => ({ globalProcessingTasks: [...state.globalProcessingTasks, task] }))
    return task.id
  },
  endGlobalProcessing: (taskId) =>
    set((state) => ({
      globalProcessingTasks: state.globalProcessingTasks.filter((task) => task.id !== taskId)
    })),
  collapsedFolderIds: loadCollapsedFolderIds(),
  availableSkills: [],
  things: [],
  showInactiveThings: false,
  loadThings: async (input) => {
    const includeInactive = input?.includeInactive ?? get().showInactiveThings
    const things = await window.api.yachiyo.listThings({ includeInactive })
    set({ things, showInactiveThings: includeInactive })
  },
  reactivateThing: async (name) => {
    await window.api.yachiyo.reactivateThing({ name })
    await get().loadThings({ includeInactive: get().showInactiveThings })
  },
  deleteThing: async (name) => {
    await window.api.yachiyo.deleteThing({ name })
    await get().loadThings({ includeInactive: get().showInactiveThings })
  },
  continueThingInNewChat: async (name) => {
    const currentState = get()
    const activeThread = findThread(currentState, currentState.activeThreadId)
    const workspacePath =
      activeThread?.workspacePath ?? currentState.pendingWorkspacePath ?? undefined
    const modelOverride =
      activeThread?.modelOverride ?? currentState.pendingModelOverride ?? undefined
    const thread = await window.api.yachiyo.continueThingInNewChat({
      name,
      ...(workspacePath ? { workspacePath } : {}),
      ...(modelOverride ? { modelOverride } : {})
    })
    set((state) => ({
      threads: upsertThread(state.threads, thread),
      activeThreadId: thread.id,
      threadListMode: 'active',
      composerDrafts: updateComposerDraft(
        state.composerDrafts,
        getComposerDraftKey(thread.id),
        () => ({
          ...EMPTY_COMPOSER_DRAFT,
          text: `#${name} `
        })
      )
    }))
  },
  toggleShowInactiveThings: () => {
    const includeInactive = !get().showInactiveThings
    set({ showInactiveThings: includeInactive })
    void get().loadThings({ includeInactive })
  },
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
    const currentState = get()
    const threadId = currentState.activeThreadId
    if (!threadId) {
      return
    }
    const thread = findThread(currentState, threadId)
    if (!thread || !canCompactThreadToAnotherThread(thread)) {
      const message = 'Handoff is only supported for local threads.'
      set({ lastError: message })
      throw new Error(message)
    }

    const reasoningEffort = getComposerReasoningEffort(currentState, threadId)

    try {
      const accepted = await window.api.yachiyo.compactThreadToAnotherThread({
        threadId,
        reasoningEffort
      })
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
          reasoningEffortByThread: {
            ...state.reasoningEffortByThread,
            [accepted.thread.id]: reasoningEffort
          },
          ...withFilterBase(state.sidebarFilter, 'all'),
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

        const toolMode = getComposerToolMode(nextState, accepted.thread.id)

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState),
          enabledTools: toolMode.enabledTools,
          runMode: toolMode.runMode
        }
      })
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : 'Unable to compact into another thread.'
      const message = rawMessage.replace(
        /^Error invoking remote method 'yachiyo:compact-thread-to-another-thread': Error: /,
        ''
      )
      set({ lastError: message })
      throw new Error(message)
    }
  },
  acceptPlanDocument: async (threadId, mode) => {
    const currentState = get()
    const planDocument = currentState.planDocumentsByThread[threadId]
    if (!planDocument) {
      const message = 'No plan document is available for this thread yet.'
      set({ lastError: message })
      throw new Error(message)
    }

    try {
      const accepted = await window.api.yachiyo.acceptThreadPlanDocument({ threadId, mode })
      if (!accepted.runId) {
        throw new Error('Plan acceptance did not start a run.')
      }
      if (!('userMessage' in accepted)) {
        throw new Error('Plan acceptance did not create an execution message.')
      }
      const acceptedUserMessage = accepted.userMessage

      set((state) => {
        const planDocumentsByThread = {
          ...state.planDocumentsByThread,
          [threadId]: {
            ...planDocument,
            decision: 'accepted' as const
          }
        }

        const nextState = {
          ...state,
          planDocumentsByThread,
          activeRequestMessageIdsByThread: {
            ...state.activeRequestMessageIdsByThread,
            [accepted.thread.id]: acceptedUserMessage.id
          },
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
          ...withFilterBase(state.sidebarFilter, 'all'),
          messages: {
            ...state.messages,
            [accepted.thread.id]: replaceMessage(
              state.messages[accepted.thread.id] ?? [],
              acceptedUserMessage
            )
          },
          toolCalls: {
            ...state.toolCalls,
            [accepted.thread.id]: state.toolCalls[accepted.thread.id] ?? []
          },
          threads: upsertThread(state.threads, accepted.thread)
        }

        const toolMode = getComposerToolMode(nextState, accepted.thread.id)

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState),
          enabledTools: toolMode.enabledTools,
          runMode: toolMode.runMode
        }
      })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to accept this plan.'
      const message = rawMessage.replace(
        /^Error invoking remote method 'yachiyo:accept-thread-plan-document': Error: /,
        ''
      )
      set({ lastError: message })
      throw new Error(message)
    }
  },
  rejectPlanDocument: async (threadId) => {
    const currentState = get()
    const planDocument = currentState.planDocumentsByThread[threadId]
    if (!planDocument) {
      const message = 'No plan document is available for this thread yet.'
      set({ lastError: message })
      throw new Error(message)
    }

    set((state) => ({
      lastError: null,
      planDocumentsByThread: {
        ...state.planDocumentsByThread,
        [threadId]: {
          ...planDocument,
          decision: 'rejected' as const
        }
      }
    }))
  },
  createBranch: async (messageId) => {
    const threadId = get().activeThreadId
    if (!threadId) {
      return
    }

    try {
      const snapshot = await window.api.yachiyo.createBranch({ threadId, messageId })
      set((state) => {
        const latestRunsByThread = { ...state.latestRunsByThread }
        delete latestRunsByThread[snapshot.thread.id]
        const toolCalls = {
          ...state.toolCalls,
          [snapshot.thread.id]: snapshot.toolCalls
        }
        const nextState = {
          ...state,
          activeThreadId: snapshot.thread.id,
          ...withFilterBase(state.sidebarFilter, 'all'),
          lastError: null,
          messages: {
            ...state.messages,
            [snapshot.thread.id]: snapshot.messages
          },
          latestRunsByThread,
          runsByThread: {
            ...state.runsByThread,
            [snapshot.thread.id]: []
          },
          toolCalls,
          ...deriveSubagentStateFromToolCalls(
            toolCalls,
            state.subagentStateById,
            state.subagentProgressTimelineByThread
          ),
          threads: upsertThread(state.threads, snapshot.thread)
        }

        const toolMode = getComposerToolMode(nextState, snapshot.thread.id)

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState),
          enabledTools: toolMode.enabledTools,
          runMode: toolMode.runMode
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create a branch.'
      set({ lastError: message })
      throw error
    }
  },
  composerDrafts: {},
  reasoningEffortByThread: {},
  toolModeByThread: {},
  config: null,
  connectionStatus: 'connecting',
  deleteThread: async (threadId) => {
    const processingTaskId = get().beginGlobalProcessing('Deleting thread...')
    try {
      await waitForGlobalProcessingPaint()
      await window.api.yachiyo.deleteThread({ threadId })
      set({ lastError: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete this thread.'
      set({ lastError: message })
      throw error
    } finally {
      get().endGlobalProcessing(processingTaskId)
    }
  },
  enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
  runMode: DEFAULT_RUN_MODE_ID,
  subagentActiveIdsByThread: {},
  subagentProgressTimelineByThread: {},
  subagentStateById: {},
  subagentFinishedResultsByThread: {},
  initialized: false,
  isBootstrapping: false,
  justDoneRunIdsByThread: {},
  lastError: null,
  latestRunsByThread: {},
  runsByThread: {},
  retryInfoByThread: {},
  runPhasesByThread: {},
  receivingModelOutputByThread: {},
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
  activeEssentialId: null,
  pendingAssistantMessages: {},
  pendingModelOverride: null,
  pendingAcpBinding: null,
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
    clearRecapForThread(set, get, threadId)

    try {
      const snapshot = await window.api.yachiyo.deleteMessage({ threadId, messageId })
      set((state) => {
        const activeRunId = state.activeRunIdsByThread[threadId]
        // While a run is active the server only allows deleting the
        // queued follow-up (the one message identified by `messageId`).
        // The snapshot won't include the in-flight assistant message
        // (not persisted until run completion), so wholesale-replacing
        // would erase streaming content.  Keep client state
        // authoritative and just drop the deleted message.
        const nextMessages = activeRunId
          ? (state.messages[threadId] ?? []).filter((m) => m.id !== messageId)
          : snapshot.messages
        const toolCalls = {
          ...state.toolCalls,
          [threadId]: snapshot.toolCalls
        }

        return {
          lastError: null,
          messages: {
            ...state.messages,
            [threadId]: nextMessages
          },
          toolCalls,
          latestRunsByThread: activeRunId
            ? state.latestRunsByThread
            : stripLatestRunTokens(state.latestRunsByThread, threadId),
          ...deriveSubagentStateFromToolCalls(
            toolCalls,
            state.subagentStateById,
            state.subagentProgressTimelineByThread
          ),
          threads: upsertThread(state.threads, snapshot.thread)
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete this message.'
      set({ lastError: message })
      throw error
    }
  },
  revertPendingSteer: async () => {
    const state = get()
    const threadId = state.activeThreadId
    if (!threadId) return
    const pending = state.pendingSteerMessages[threadId]
    if (!pending) return

    // Withdraw on the server so cancelRun won't deliver it as a follow-up
    await window.api.yachiyo.withdrawPendingSteer({ threadId })

    const draftKey = getComposerDraftKey(threadId)
    const currentDraft = get().composerDrafts[draftKey] ?? EMPTY_COMPOSER_DRAFT
    const mergedText = [pending.content, currentDraft.text]
      .filter((part) => part.length > 0)
      .join('\n')
    const imageDrafts: ComposerImageDraft[] = (pending.images ?? []).map((img) => ({
      id: crypto.randomUUID(),
      status: 'ready' as const,
      dataUrl: img.dataUrl,
      mediaType: img.mediaType,
      filename: img.filename ?? undefined
    }))
    const fileDrafts: ComposerFileDraft[] = (pending.files ?? []).map((file) => ({
      ...file,
      id: crypto.randomUUID()
    }))
    // Restore the most recent segment's skill override so the user resends
    // with the same configuration they originally queued.
    const lastSegment = pending.segments[pending.segments.length - 1]
    const restoredSkillNames = lastSegment?.enabledSkillNames

    set((s) => ({
      composerDrafts: updateComposerDraft(s.composerDrafts, draftKey, (draft) => ({
        ...draft,
        text: mergedText,
        images: [...imageDrafts, ...draft.images],
        files: [...fileDrafts, ...draft.files],
        enabledSkillNames: restoredSkillNames ?? draft.enabledSkillNames
      })),
      pendingSteerMessages: removePendingSteerMessage(s.pendingSteerMessages, threadId)
    }))
  },
  revertQueuedFollowUp: async (messageId) => {
    const state = get()
    const threadId = state.activeThreadId
    if (!threadId) return
    const message = (state.messages[threadId] ?? []).find((m) => m.id === messageId)
    if (!message) return

    const draftKey = getComposerDraftKey(threadId)
    const currentDraft = state.composerDrafts[draftKey] ?? EMPTY_COMPOSER_DRAFT
    const mergedText = [message.content, currentDraft.text]
      .filter((part) => part.length > 0)
      .join('\n')
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
      composerDrafts: updateComposerDraft(s.composerDrafts, draftKey, (draft) => ({
        ...draft,
        text: mergedText,
        images: [...imageDrafts, ...draft.images],
        files: [...fileDrafts, ...draft.files]
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
            get().upsertComposerFile({ ...draft, dataUrl, status: 'ready' }, threadId)
          })
          .catch(() => {
            get().upsertComposerFile(
              { ...draft, status: 'failed', error: 'Could not load attachment' },
              threadId
            )
          })
      }
    }

    await get().deleteMessage(messageId)
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
  externalThreads: [],
  showExternalThreads: false,
  threadListMode: deriveThreadListMode(loadSidebarFilter()),
  sidebarFilter: loadSidebarFilter(),
  todoListsByThread: {},
  sentinelsByThread: {},
  planDocumentsByThread: {},
  toolCalls: {},
  snapshotReviewByRun: {},
  clearSnapshotReview: (runId) =>
    set((state) => {
      const next = { ...state.snapshotReviewByRun }
      delete next[runId]
      return { snapshotReviewByRun: next }
    }),
  updateSnapshotFileCount: (threadId, runId, fileCount) =>
    set((state) => ({
      runsByThread: updateRunRecord(state.runsByThread, threadId, runId, (run) => ({
        ...run!,
        snapshotFileCount: fileCount
      })),
      latestRunsByThread:
        state.latestRunsByThread[threadId]?.id === runId
          ? {
              ...state.latestRunsByThread,
              [threadId]: { ...state.latestRunsByThread[threadId]!, snapshotFileCount: fileCount }
            }
          : state.latestRunsByThread
    })),

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
        window.api.yachiyo.showNotification({ title, body, threadId, target: 'thread' })
        set((s) => ({
          queuedToasts: [
            ...s.queuedToasts,
            { id: crypto.randomUUID(), threadId, title, body, eventKey: key }
          ]
        }))
      }
    }

    if (event.type === 'background-task.started') {
      useBackgroundTasksStore.getState().onStarted(event)
    }

    if (event.type === 'background-task.log-append') {
      useBackgroundTasksStore.getState().onLogAppend(event)
    }

    if (event.type === 'background-task.completed') {
      useBackgroundTasksStore.getState().onCompleted(event)
    }

    if (event.type === 'thread.deleted') {
      useBackgroundTasksStore.getState().clearThread(event.threadId)
    }

    if (event.type === 'notification.requested') {
      // OS notification is already handled by the gateway broadcast — only show
      // in-app toast here to avoid duplicate system notifications.
      const thread = get().threads.find((t) => t.id === event.threadId)
      if (thread && shouldSuppressOwnerDmChannelNotification(thread, event)) return

      const key = `notification.requested:${event.runId}`
      if (shouldShowNotification(key)) {
        const { activeThreadId } = get()
        const isForeground = !document.hidden && document.hasFocus()
        if (isForeground && event.threadId !== activeThreadId) {
          set((s) => ({
            activeToasts: [
              ...s.activeToasts,
              {
                id: crypto.randomUUID(),
                threadId: event.threadId,
                title: event.title,
                body: event.body,
                eventKey: key
              }
            ]
          }))
        } else if (!isForeground) {
          set((s) => ({
            queuedToasts: [
              ...s.queuedToasts,
              {
                id: crypto.randomUUID(),
                threadId: event.threadId,
                title: event.title,
                body: event.body,
                eventKey: key
              }
            ]
          }))
        }
      }
    }

    if (event.type === 'run.completed') {
      if (event.recap) return
      const { config, threads, messages } = get()
      const thread = threads.find((t) => t.id === event.threadId)
      if (
        thread &&
        !isExternalThread(thread) &&
        !shouldSuppressOwnerDmChannelNotification(thread, event) &&
        config?.general?.notifyRunCompleted !== false
      ) {
        const threadMessages = messages[event.threadId] ?? []
        const lastAssistantMessage = [...threadMessages]
          .reverse()
          .find((m) => m.role === 'assistant')
        const lastTextBlock = lastAssistantMessage?.textBlocks?.at(-1)
        const preview =
          lastTextBlock?.content.trim().slice(0, 60) ??
          lastAssistantMessage?.content.trim().slice(0, 60) ??
          'Run completed'
        notifyActivity(`run.completed:${event.runId}`, event.threadId, thread.title, preview)
      }
    }

    if (event.type === 'snapshot.ready') {
      set((state) => ({
        snapshotReviewByRun: withSnapshotReviewLimit({
          ...state.snapshotReviewByRun,
          [event.runId]: {
            threadId: event.threadId,
            fileCount: event.fileCount,
            workspacePath: event.workspacePath
          }
        }),
        runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
          ...run!,
          snapshotFileCount: event.fileCount,
          workspacePath: event.workspacePath
        })),
        latestRunsByThread:
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? {
                ...state.latestRunsByThread,
                [event.threadId]: {
                  ...state.latestRunsByThread[event.threadId]!,
                  snapshotFileCount: event.fileCount,
                  workspacePath: event.workspacePath
                }
              }
            : state.latestRunsByThread
      }))
    }

    if (event.type === 'subagent.started') {
      const { config, threads } = get()
      const thread = threads.find((t) => t.id === event.threadId)
      if (
        thread &&
        !isExternalThread(thread) &&
        !shouldSuppressOwnerDmChannelNotification(thread, event) &&
        config?.general?.notifyCodingTaskStarted !== false
      ) {
        notifyActivity(
          `subagent.started:${event.runId}:${event.agentName}`,
          event.threadId,
          thread.title,
          `${event.agentName} dispatched`
        )
      }
    }

    if (event.type === 'subagent.finished') {
      const { config, threads } = get()
      const thread = threads.find((t) => t.id === event.threadId)
      if (
        thread &&
        !isExternalThread(thread) &&
        !shouldSuppressOwnerDmChannelNotification(thread, event) &&
        config?.general?.notifyCodingTaskFinished !== false
      ) {
        notifyActivity(
          `subagent.finished:${event.runId}:${event.agentName}:${event.status}`,
          event.threadId,
          thread.title,
          event.status === 'cancelled'
            ? `${event.agentName} cancelled`
            : `${event.agentName} finished`
        )
      }
    }

    if (
      event.type === 'tool.updated' &&
      event.toolCall.toolName === PLAN_MODE_EXIT_TOOL_NAME &&
      event.toolCall.status === 'completed'
    ) {
      void (async () => {
        try {
          const plan = await window.api.yachiyo.readThreadPlanDocument({ threadId: event.threadId })
          set((state) => ({
            planDocumentsByThread: {
              ...state.planDocumentsByThread,
              [event.threadId]: {
                ...plan,
                updatedAt: event.timestamp,
                decision: plan.decision ?? 'pending'
              }
            }
          }))
        } catch {
          // Ignore missing plan files or read errors.
        }
      })()
    }

    if (
      event.type === 'message.completed' &&
      event.message.role === 'assistant' &&
      isPlanModeExitRecord(event.message)
    ) {
      void (async () => {
        try {
          const plan = await window.api.yachiyo.readThreadPlanDocument({ threadId: event.threadId })
          set((state) => ({
            planDocumentsByThread: {
              ...state.planDocumentsByThread,
              [event.threadId]: {
                ...plan,
                updatedAt: event.timestamp,
                decision: plan.decision ?? 'pending'
              }
            }
          }))
        } catch {
          // Ignore missing plan files or read errors.
        }
      })()
    }

    set((state) => reduceServerEvent(state, event))
  },

  ...createThreadLifecycleActions({ set, get }),
  ...createSendMessageActions({ set, get }),
  ...createComposerUiActions({ set, get })
}))
