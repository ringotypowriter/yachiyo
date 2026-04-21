import { create } from 'zustand'

import type {
  ConnectionStatus,
  FolderRecord,
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
  ThreadModelOverride,
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
  USER_MANAGED_TOOL_NAMES,
  normalizeUserEnabledTools,
  normalizeSkillNames,
  type ThreadRuntimeBinding
} from '../../../../shared/yachiyo/protocol.ts'
import { sortToolCallsChronologically } from '../../../../shared/yachiyo/toolCallOrder.ts'
import { collectDescendantIds, collectMessagePath } from '../../../../shared/yachiyo/threadTree.ts'
import { useBackgroundTasksStore } from '../../features/chat/state/useBackgroundTasksStore.ts'

interface PendingAssistantMessage {
  messageId: string
  threadId: string
  parentMessageId?: string
  shouldStartNewTextBlock: boolean
}

interface PendingSteerSegment {
  content: string
  images?: MessageImageRecord[]
  files?: ComposerFileDraft[]
  enabledSkillNames?: string[] | null
}

interface PendingSteerMessage {
  segments: PendingSteerSegment[]
  /** Flattened content for display — kept in sync with segments. */
  content: string
  createdAt: string
  images?: MessageImageRecord[]
  files?: ComposerFileDraft[]
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

interface ActiveSubagentState {
  delegationId: string
  threadId: string
  agentName: string
  progress: string
  workspacePath?: string
}

interface SubagentProgressEntry {
  delegationId: string
  agentName: string
  chunk: string
}

export interface SendMessageOverride {
  content: string
  images: MessageImageRecord[]
  attachments: SendChatAttachment[]
  enabledSkillNames?: string[] | null
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
  subagentActiveIdsByThread: Record<string, string[]>
  subagentProgressTimelineByThread: Record<string, SubagentProgressEntry[]>
  subagentStateById: Record<string, ActiveSubagentState>
  initialized: boolean
  isBootstrapping: boolean
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
  savingThreadIds: Set<string>
  saveThread: (threadId: string, options?: { archiveAfterSave?: boolean }) => Promise<void>
  selectReplyBranch: (messageId: string) => Promise<void>
  runPhase: 'idle' | 'preparing' | 'streaming'
  runStatus: RunStatus
  runStatusesByThread: Record<string, RunStatus>
  settings: ProviderSettings
  threads: Thread[]
  folders: FolderRecord[]
  collapsedFolderIds: Set<string>
  externalThreads: Thread[]
  showExternalThreads: boolean
  threadListMode: 'active' | 'archived'
  toolCalls: Record<string, ToolCall[]>
  /** Snapshot review info per run, set by snapshot.ready events. */
  snapshotReviewByRun: Record<
    string,
    { threadId: string; fileCount: number; workspacePath: string }
  >
  clearSnapshotReview: (runId: string) => void

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
  recapByThread: Record<string, string>
  scrollToMessageId: string | null
  setScrollToMessageId: (messageId: string) => void
  clearScrollToMessageId: () => void
  setActiveThread: (id: string, scrollToMessageId?: string) => void
  setActiveArchivedThread: (id: string) => void
  setComposerValue: (value: string) => void
  setComposerEnabledSkillNames: (enabledSkillNames: string[] | null) => void
  setPendingWorkspacePath: (workspacePath: string | null) => void
  setPendingAcpBinding: (binding: ThreadRuntimeBinding | null) => void
  setThreadWorkspace: (workspacePath: string | null, threadId?: string | null) => Promise<void>
  setThreadListMode: (mode: 'active' | 'archived') => void
  toggleShowExternalThreads: () => void
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
  state: Pick<AppState, 'activeThreadId' | 'threads' | 'settings' | 'pendingModelOverride'>
): { providerName: string; model: string } {
  const thread = findThread(state, state.activeThreadId)
  const override = thread?.modelOverride
  if (override) return override
  if (!state.activeThreadId && state.pendingModelOverride) return state.pendingModelOverride
  return { providerName: state.settings.providerName, model: state.settings.model }
}

export function getThreadEffectiveModel(
  state: Pick<AppState, 'threads' | 'settings'>,
  threadId: string | null
): { providerName: string; model: string } {
  const thread = findThread(state, threadId)
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
  return USER_MANAGED_TOOL_NAMES.filter((currentToolName) => nextEnabledTools.has(currentToolName))
}

function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function isExternalThread(thread: Thread): boolean {
  if (thread.source && thread.source !== 'local') return true
  if (thread.channelUserId) return true
  return false
}

function isVisibleExternalThread(thread: Thread): boolean {
  return isExternalThread(thread) && !thread.channelGroupId
}

/** Find a thread by ID across both local and external thread lists. */
export function findThread(
  state: { threads: Thread[]; externalThreads?: Thread[] },
  threadId: string | null
): Thread | undefined {
  if (!threadId) return undefined
  return (
    state.threads.find((t) => t.id === threadId) ??
    state.externalThreads?.find((t) => t.id === threadId)
  )
}

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  if (isExternalThread(thread)) return threads
  return sortThreads([thread, ...threads.filter((item) => item.id !== thread.id)])
}

function removeThread(threads: Thread[], threadId: string): Thread[] {
  return threads.filter((thread) => thread.id !== threadId)
}

function upsertFolder(folders: FolderRecord[], folder: FolderRecord): FolderRecord[] {
  return [folder, ...folders.filter((f) => f.id !== folder.id)]
}

function removeFolder(folders: FolderRecord[], folderId: string): FolderRecord[] {
  return folders.filter((f) => f.id !== folderId)
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
  return sortToolCallsChronologically(next)
}

function upsertActiveSubagentId(
  subagentActiveIdsByThread: Record<string, string[]>,
  threadId: string,
  delegationId: string
): Record<string, string[]> {
  const current = subagentActiveIdsByThread[threadId] ?? []
  if (current.includes(delegationId)) {
    return subagentActiveIdsByThread
  }

  return {
    ...subagentActiveIdsByThread,
    [threadId]: [...current, delegationId]
  }
}

function removeActiveSubagentId(
  subagentActiveIdsByThread: Record<string, string[]>,
  threadId: string,
  delegationId: string
): Record<string, string[]> {
  const current = subagentActiveIdsByThread[threadId]
  if (!current) {
    return subagentActiveIdsByThread
  }

  const next = current.filter((id) => id !== delegationId)
  if (next.length === current.length) {
    return subagentActiveIdsByThread
  }
  if (next.length === 0) {
    const updated = { ...subagentActiveIdsByThread }
    delete updated[threadId]
    return updated
  }

  return {
    ...subagentActiveIdsByThread,
    [threadId]: next
  }
}

function appendSubagentProgressEntry(
  progressByThread: Record<string, SubagentProgressEntry[]>,
  threadId: string,
  entry: SubagentProgressEntry
): Record<string, SubagentProgressEntry[]> {
  return {
    ...progressByThread,
    [threadId]: [...(progressByThread[threadId] ?? []), entry]
  }
}

function deriveSubagentStateFromToolCalls(
  toolCallsByThread: Record<string, ToolCall[]>,
  previousStateById: Record<string, ActiveSubagentState> = {},
  previousProgressByThread: Record<string, SubagentProgressEntry[]> = {}
): Pick<
  AppState,
  'subagentActiveIdsByThread' | 'subagentProgressTimelineByThread' | 'subagentStateById'
> {
  const subagentActiveIdsByThread: Record<string, string[]> = {}
  const subagentProgressTimelineByThread: Record<string, SubagentProgressEntry[]> = {}
  const subagentStateById: Record<string, ActiveSubagentState> = {}

  for (const [threadId, toolCalls] of Object.entries(toolCallsByThread)) {
    const activeDelegationIds: string[] = []
    for (const toolCall of toolCalls) {
      if (toolCall.toolName !== 'delegateCodingTask' || toolCall.status !== 'running') {
        continue
      }

      activeDelegationIds.push(toolCall.id)
      subagentActiveIdsByThread[threadId] = [
        ...(subagentActiveIdsByThread[threadId] ?? []),
        toolCall.id
      ]
      const previous = previousStateById[toolCall.id]
      subagentStateById[toolCall.id] = {
        delegationId: toolCall.id,
        threadId,
        agentName: previous?.agentName || toolCall.inputSummary || 'Coding agent',
        progress: previous?.progress ?? '',
        ...(previous?.workspacePath ? { workspacePath: previous.workspacePath } : {})
      }
    }

    if (activeDelegationIds.length > 0) {
      const activeDelegationIdSet = new Set(activeDelegationIds)
      subagentProgressTimelineByThread[threadId] = (
        previousProgressByThread[threadId] ?? []
      ).filter((entry) => activeDelegationIdSet.has(entry.delegationId))
    }
  }

  return {
    subagentActiveIdsByThread,
    subagentProgressTimelineByThread,
    subagentStateById
  }
}

function syncSubagentStateWithToolCall(input: {
  threadId: string
  toolCall: ToolCall
  subagentActiveIdsByThread: Record<string, string[]>
  subagentStateById: Record<string, ActiveSubagentState>
}): Pick<AppState, 'subagentActiveIdsByThread' | 'subagentStateById'> {
  if (input.toolCall.toolName !== 'delegateCodingTask') {
    return {
      subagentActiveIdsByThread: input.subagentActiveIdsByThread,
      subagentStateById: input.subagentStateById
    }
  }

  if (input.toolCall.status === 'running') {
    return {
      subagentActiveIdsByThread: upsertActiveSubagentId(
        input.subagentActiveIdsByThread,
        input.threadId,
        input.toolCall.id
      ),
      subagentStateById: {
        ...input.subagentStateById,
        [input.toolCall.id]: {
          delegationId: input.toolCall.id,
          threadId: input.threadId,
          agentName:
            input.subagentStateById[input.toolCall.id]?.agentName ||
            input.toolCall.inputSummary ||
            'Coding agent',
          progress: input.subagentStateById[input.toolCall.id]?.progress ?? '',
          ...(input.subagentStateById[input.toolCall.id]?.workspacePath
            ? { workspacePath: input.subagentStateById[input.toolCall.id]?.workspacePath }
            : {})
        }
      }
    }
  }

  const subagentStateById = { ...input.subagentStateById }
  delete subagentStateById[input.toolCall.id]
  return {
    subagentActiveIdsByThread: removeActiveSubagentId(
      input.subagentActiveIdsByThread,
      input.threadId,
      input.toolCall.id
    ),
    subagentStateById
  }
}

function terminateRunToolCalls(
  allToolCalls: Record<string, ToolCall[]>,
  threadId: string,
  runId: string,
  assistantMessageId: string | undefined
): Record<string, ToolCall[]> {
  const threadToolCalls = allToolCalls[threadId]
  if (!threadToolCalls) return allToolCalls

  let changed = false
  const next = threadToolCalls.map((toolCall) => {
    if (toolCall.runId !== runId) return toolCall

    const needsFailStatus = toolCall.status === 'preparing' || toolCall.status === 'running'
    const needsBind = assistantMessageId && !toolCall.assistantMessageId
    if (!needsFailStatus && !needsBind) return toolCall

    changed = true
    return {
      ...toolCall,
      ...(needsFailStatus ? { status: 'failed' as const } : {}),
      ...(needsBind ? { assistantMessageId } : {})
    }
  })

  return changed ? { ...allToolCalls, [threadId]: next } : allToolCalls
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

function buildPendingSteerFromSegments(segments: PendingSteerSegment[]): PendingSteerMessage {
  const content = segments.map((s) => s.content).join('\n')
  const images = segments.flatMap((s) => s.images ?? [])
  const files = segments.flatMap((s) => s.files ?? [])
  return {
    segments,
    content,
    createdAt: new Date().toISOString(),
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {})
  }
}

function appendPendingSteer(
  existing: PendingSteerMessage | undefined,
  content: string,
  images: MessageImageRecord[],
  files: ComposerFileDraft[],
  enabledSkillNames: string[] | null
): PendingSteerMessage {
  const newSegment: PendingSteerSegment = {
    content,
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
    enabledSkillNames
  }
  const segments = [...(existing?.segments ?? []), newSegment]
  return buildPendingSteerFromSegments(segments)
}

function removePendingSteerMessage(
  pendingSteerMessages: Record<string, PendingSteerMessage>,
  threadId: string
): Record<string, PendingSteerMessage> {
  const next = { ...pendingSteerMessages }
  delete next[threadId]
  return next
}

function removeThreadRetryInfo(
  retryInfoByThread: AppState['retryInfoByThread'],
  threadId: string
): AppState['retryInfoByThread'] {
  if (!(threadId in retryInfoByThread)) {
    return retryInfoByThread
  }

  const next = { ...retryInfoByThread }
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
  const activeThread =
    state.threads.find((thread) => thread.id === state.activeThreadId) ??
    state.externalThreads.find((thread) => thread.id === state.activeThreadId) ??
    null
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

// Module-level send dedup guard. Survives Composer remounts and concurrent
// callers (Enter key, Send button, programmatic). Keyed by thread+mode+content
// fingerprint with both an in-flight lock and a recency window.
const SEND_DEDUP_WINDOW_MS = 1500
function clearRecapForThread(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  threadId: string
): void {
  const state = get()
  const hasCache = Boolean(state.recapByThread[threadId])
  const thread = state.threads.find((t) => t.id === threadId)
  const hasPersisted = Boolean(thread?.recapText)
  if (!hasCache && !hasPersisted) return

  const updates: Partial<AppState> = {}
  if (hasCache) {
    const next = { ...state.recapByThread }
    delete next[threadId]
    updates.recapByThread = next
  }
  if (hasPersisted && thread) {
    updates.threads = state.threads.map((t) =>
      t.id === threadId ? { ...t, recapText: undefined } : t
    )
  }
  set(updates)
  void window.api.yachiyo.clearRecapText({ threadId }).catch(() => {})
}

let sendInFlight = false
let lastSendFingerprint: string | null = null
let lastSendAt = 0

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
  collapsedFolderIds: new Set<string>(),
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
  createBranch: async (messageId) => {
    const threadId = get().activeThreadId
    if (!threadId) {
      return
    }

    try {
      const snapshot = await window.api.yachiyo.createBranch({ threadId, messageId })
      set((state) => {
        const toolCalls = {
          ...state.toolCalls,
          [snapshot.thread.id]: snapshot.toolCalls
        }
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
          toolCalls,
          ...deriveSubagentStateFromToolCalls(
            toolCalls,
            state.subagentStateById,
            state.subagentProgressTimelineByThread
          ),
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
  subagentActiveIdsByThread: {},
  subagentProgressTimelineByThread: {},
  subagentStateById: {},
  initialized: false,
  isBootstrapping: false,
  lastError: null,
  latestRunsByThread: {},
  runsByThread: {},
  retryInfoByThread: {},
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
          // Preserve harness progress while a run is active.
          harnessEvents: activeRunId
            ? state.harnessEvents
            : { ...state.harnessEvents, [threadId]: [] },
          lastError: null,
          messages: {
            ...state.messages,
            [threadId]: nextMessages
          },
          toolCalls,
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
  threadListMode: 'active',
  toolCalls: {},
  snapshotReviewByRun: {},
  clearSnapshotReview: (runId) =>
    set((state) => {
      const next = { ...state.snapshotReviewByRun }
      delete next[runId]
      return { snapshotReviewByRun: next }
    }),

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

    if (event.type === 'background-task.started') {
      useBackgroundTasksStore.getState().onStarted(event)
    }

    if (event.type === 'background-task.log-append') {
      useBackgroundTasksStore.getState().onLogAppend(event)
    }

    if (event.type === 'background-task.completed') {
      useBackgroundTasksStore.getState().onCompleted(event)
    }

    if (event.type === 'notification.requested') {
      // OS notification is already handled by the gateway broadcast — only show
      // in-app toast here to avoid duplicate system notifications.
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
      if (thread && !isExternalThread(thread) && config?.general?.notifyRunCompleted !== false) {
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
        snapshotReviewByRun: {
          ...state.snapshotReviewByRun,
          [event.runId]: {
            threadId: event.threadId,
            fileCount: event.fileCount,
            workspacePath: event.workspacePath
          }
        },
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
        const externalThreads = removeThread(state.externalThreads, event.threadId)
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
        const subagentActiveIdsByThread = { ...state.subagentActiveIdsByThread }
        delete subagentActiveIdsByThread[event.threadId]
        const subagentProgressTimelineByThread = { ...state.subagentProgressTimelineByThread }
        delete subagentProgressTimelineByThread[event.threadId]
        const subagentStateById = Object.fromEntries(
          Object.entries(state.subagentStateById).filter(
            ([, subagent]) => subagent.threadId !== event.threadId
          )
        )

        const deletingActiveThread = state.activeThreadId === event.threadId
        const activeThreadId = deletingActiveThread
          ? (threads[0]?.id ?? null)
          : state.activeThreadId
        const nextState = {
          ...state,
          ...(deletingActiveThread
            ? {
                activeEssentialId: null,
                pendingModelOverride: null,
                pendingAcpBinding: null,
                pendingWorkspacePath: null
              }
            : {}),
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
          subagentActiveIdsByThread,
          subagentProgressTimelineByThread,
          subagentStateById,
          externalThreads,
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
          externalThreads: isVisibleExternalThread(event.thread)
            ? sortThreads([
                event.thread,
                ...state.externalThreads.filter((item) => item.id !== event.thread.id)
              ])
            : state.externalThreads,
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
        const activeRunId = state.activeRunIdsByThread[event.threadId]
        const nextActiveRequestMessageId = activeRunId
          ? resolveActiveRequestMessageId(
              event.thread,
              event.messages,
              state.activeRequestMessageIdsByThread[event.threadId] ?? null
            )
          : (state.activeRequestMessageIdsByThread[event.threadId] ?? null)

        // While a run is active, the server snapshot won't contain the
        // in-flight assistant message (not persisted until completion).
        // Server messages are still authoritative for persisted state
        // (steers, deletions), so use them — but re-inject the single
        // pending assistant message that only exists client-side.
        let nextMessages = event.messages
        if (activeRunId) {
          const pending = state.pendingAssistantMessages[activeRunId]
          if (pending) {
            const live = (state.messages[event.threadId] ?? []).find(
              (m) => m.id === pending.messageId
            )
            if (live && !nextMessages.some((m) => m.id === pending.messageId)) {
              nextMessages = upsertMessage(nextMessages, live)
            }
          }
        }

        // When a pending steer resolves (tool just finished), the run is
        // about to restart. Reset to 'preparing' so the conversation group
        // shows a PreparingBubble instead of empty space while waiting for
        // the first message.delta from the restarted run.
        const hadPendingSteer = Boolean(state.pendingSteerMessages[event.threadId])
        const toolCalls = {
          ...state.toolCalls,
          [event.threadId]: event.toolCalls
        }

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread: setThreadStringValue(
            state.activeRequestMessageIdsByThread,
            event.threadId,
            nextActiveRequestMessageId
          ),
          archivedThreads: removeThread(state.archivedThreads, event.threadId),
          harnessEvents: activeRunId
            ? state.harnessEvents
            : { ...state.harnessEvents, [event.threadId]: [] },
          messages: {
            ...state.messages,
            [event.threadId]: nextMessages
          },
          pendingSteerMessages: removePendingSteerMessage(
            state.pendingSteerMessages,
            event.threadId
          ),
          runPhasesByThread: hadPendingSteer
            ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'preparing')
            : state.runPhasesByThread,
          toolCalls,
          ...deriveSubagentStateFromToolCalls(
            toolCalls,
            state.subagentStateById,
            state.subagentProgressTimelineByThread
          ),
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

        const retryInfoByThread = { ...state.retryInfoByThread }
        delete retryInfoByThread[event.threadId]

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
          retryInfoByThread,
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
        const pendingAssistantMessages =
          event.message.role === 'assistant'
            ? (() => {
                const next = { ...state.pendingAssistantMessages }
                delete next[event.runId]
                return next
              })()
            : state.pendingAssistantMessages

        return {
          messages: {
            ...state.messages,
            [event.threadId]: upsertMessage(state.messages[event.threadId] ?? [], event.message)
          },
          pendingAssistantMessages
        }
      }

      if (event.type === 'tool.updated') {
        const eventRunId = event.runId
        const pending = eventRunId ? state.pendingAssistantMessages[eventRunId] : undefined
        const currentPhase = state.runPhasesByThread[event.threadId]
        const nextToolCalls = {
          ...state.toolCalls,
          [event.threadId]: upsertToolCall(state.toolCalls[event.threadId] ?? [], event.toolCall)
        }
        const nextSubagentState = syncSubagentStateWithToolCall({
          threadId: event.threadId,
          toolCall: event.toolCall,
          subagentActiveIdsByThread: state.subagentActiveIdsByThread,
          subagentStateById: state.subagentStateById
        })
        const nextState = {
          ...state,
          pendingAssistantMessages: pending
            ? {
                ...state.pendingAssistantMessages,
                [eventRunId!]: {
                  ...pending,
                  shouldStartNewTextBlock: true
                }
              }
            : state.pendingAssistantMessages,
          toolCalls: nextToolCalls,
          ...nextSubagentState,
          runPhasesByThread:
            currentPhase === 'preparing' && event.toolCall.status !== 'preparing'
              ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'streaming')
              : state.runPhasesByThread
        }
        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'run.retrying') {
        const pending = state.pendingAssistantMessages[event.runId]
        const nextThreadMessages = pending
          ? (state.messages[event.threadId] ?? []).map((message) => {
              if (message.id !== pending.messageId || message.reasoning === undefined) {
                return message
              }

              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { reasoning: _reasoning, ...nextMessage } = message
              return nextMessage
            })
          : undefined

        return {
          ...(nextThreadMessages
            ? {
                messages: {
                  ...state.messages,
                  [event.threadId]: nextThreadMessages
                }
              }
            : {}),
          retryInfoByThread: {
            ...state.retryInfoByThread,
            [event.threadId]: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              error: event.error
            }
          }
        }
      }

      if (event.type === 'run.completed') {
        const isCurrentActiveRun = state.activeRunIdsByThread[event.threadId] === event.runId
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const activeRunIdsByThread = isCurrentActiveRun
          ? setThreadStringValue(state.activeRunIdsByThread, event.threadId, null)
          : state.activeRunIdsByThread
        const activeRequestMessageIdsByThread = isCurrentActiveRun
          ? setThreadStringValue(state.activeRequestMessageIdsByThread, event.threadId, null)
          : state.activeRequestMessageIdsByThread
        const retryInfoByThread = isCurrentActiveRun
          ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
          : state.retryInfoByThread
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread,
          activeRunIdsByThread,
          retryInfoByThread,
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
          pendingSteerMessages: isCurrentActiveRun
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          runPhasesByThread: isCurrentActiveRun
            ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'idle')
            : state.runPhasesByThread,
          runStatusesByThread: isCurrentActiveRun
            ? setThreadRunStatusValue(state.runStatusesByThread, event.threadId, 'idle')
            : state.runStatusesByThread
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'run.failed') {
        const isCurrentActiveRun = state.activeRunIdsByThread[event.threadId] === event.runId
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const activeRunIdsByThread = isCurrentActiveRun
          ? setThreadStringValue(state.activeRunIdsByThread, event.threadId, null)
          : state.activeRunIdsByThread
        const activeRequestMessageIdsByThread = isCurrentActiveRun
          ? setThreadStringValue(state.activeRequestMessageIdsByThread, event.threadId, null)
          : state.activeRequestMessageIdsByThread
        const retryInfoByThread = isCurrentActiveRun
          ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
          : state.retryInfoByThread
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread,
          retryInfoByThread,
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
          pendingSteerMessages: isCurrentActiveRun
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          toolCalls: terminateRunToolCalls(
            state.toolCalls,
            event.threadId,
            event.runId,
            pending?.messageId
          ),
          runPhasesByThread: isCurrentActiveRun
            ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'idle')
            : state.runPhasesByThread,
          runStatusesByThread: isCurrentActiveRun
            ? setThreadRunStatusValue(state.runStatusesByThread, event.threadId, 'failed')
            : state.runStatusesByThread
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      }

      if (event.type === 'run.cancelled') {
        const isCurrentActiveRun = state.activeRunIdsByThread[event.threadId] === event.runId
        const pending = state.pendingAssistantMessages[event.runId]
        const pendingAssistantMessages = { ...state.pendingAssistantMessages }
        delete pendingAssistantMessages[event.runId]
        const activeRunIdsByThread = isCurrentActiveRun
          ? setThreadStringValue(state.activeRunIdsByThread, event.threadId, null)
          : state.activeRunIdsByThread
        const activeRequestMessageIdsByThread = isCurrentActiveRun
          ? setThreadStringValue(state.activeRequestMessageIdsByThread, event.threadId, null)
          : state.activeRequestMessageIdsByThread
        const retryInfoByThread = isCurrentActiveRun
          ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
          : state.retryInfoByThread
        const existingLatestRun =
          state.latestRunsByThread[event.threadId]?.id === event.runId
            ? state.latestRunsByThread[event.threadId]
            : undefined

        const nextState = {
          ...state,
          activeRequestMessageIdsByThread,
          activeRunIdsByThread,
          retryInfoByThread,
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
          pendingSteerMessages: isCurrentActiveRun
            ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
            : state.pendingSteerMessages,
          toolCalls: terminateRunToolCalls(
            state.toolCalls,
            event.threadId,
            event.runId,
            pending?.messageId
          ),
          runPhasesByThread: isCurrentActiveRun
            ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'idle')
            : state.runPhasesByThread,
          runStatusesByThread: isCurrentActiveRun
            ? setThreadRunStatusValue(state.runStatusesByThread, event.threadId, 'cancelled')
            : state.runStatusesByThread
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
        const existing = state.subagentStateById[event.delegationId]
        const hadActiveDelegates =
          (state.subagentActiveIdsByThread[event.threadId]?.length ?? 0) > 0
        return {
          subagentActiveIdsByThread: upsertActiveSubagentId(
            state.subagentActiveIdsByThread,
            event.threadId,
            event.delegationId
          ),
          subagentProgressTimelineByThread: hadActiveDelegates
            ? state.subagentProgressTimelineByThread
            : {
                ...state.subagentProgressTimelineByThread,
                [event.threadId]: []
              },
          subagentStateById: {
            ...state.subagentStateById,
            [event.delegationId]: {
              delegationId: event.delegationId,
              threadId: event.threadId,
              agentName: event.agentName,
              progress: existing?.progress ?? '',
              workspacePath: event.workspacePath
            }
          }
        }
      }

      if (event.type === 'subagent.progress') {
        const existing = state.subagentStateById[event.delegationId]
        const agentName = existing?.agentName ?? 'Coding agent'
        return {
          subagentActiveIdsByThread: upsertActiveSubagentId(
            state.subagentActiveIdsByThread,
            event.threadId,
            event.delegationId
          ),
          subagentProgressTimelineByThread: appendSubagentProgressEntry(
            state.subagentProgressTimelineByThread,
            event.threadId,
            {
              delegationId: event.delegationId,
              agentName,
              chunk: event.chunk
            }
          ),
          subagentStateById: {
            ...state.subagentStateById,
            [event.delegationId]: {
              delegationId: event.delegationId,
              threadId: event.threadId,
              agentName,
              progress: (existing?.progress ?? '') + event.chunk,
              ...(existing?.workspacePath ? { workspacePath: existing.workspacePath } : {})
            }
          }
        }
      }

      if (event.type === 'subagent.finished') {
        const subagentStateById = { ...state.subagentStateById }
        delete subagentStateById[event.delegationId]
        const subagentActiveIdsByThread = removeActiveSubagentId(
          state.subagentActiveIdsByThread,
          event.threadId,
          event.delegationId
        )
        const subagentProgressTimelineByThread = { ...state.subagentProgressTimelineByThread }
        if ((subagentActiveIdsByThread[event.threadId]?.length ?? 0) === 0) {
          delete subagentProgressTimelineByThread[event.threadId]
        }
        return {
          subagentActiveIdsByThread,
          subagentProgressTimelineByThread,
          subagentStateById
        }
      }

      if (event.type === 'folder.created' || event.type === 'folder.updated') {
        return { folders: upsertFolder(state.folders, event.folder) }
      }

      if (event.type === 'folder.deleted') {
        const nextCollapsed = new Set(state.collapsedFolderIds)
        nextCollapsed.delete(event.folderId)
        return {
          folders: removeFolder(state.folders, event.folderId),
          collapsedFolderIds: nextCollapsed
        }
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
          activeEssentialId: null,
          pendingModelOverride: null,
          pendingAcpBinding: null,
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
        activeEssentialId: null,
        pendingModelOverride: null,
        pendingAcpBinding: null,
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

  createNewThreadFromEssential: (essentialId) => {
    const config = get().config
    const essential = config?.essentials?.find((e) => e.id === essentialId)
    if (!essential) return

    set((state) => ({
      activeThreadId: null,
      activeEssentialId: essentialId,
      pendingWorkspacePath: normalizeWorkspacePath(essential.workspacePath ?? null),
      pendingModelOverride: essential.modelOverride ?? null,
      composerDrafts: removeComposerDraft(state.composerDrafts, null),
      threadListMode: 'active' as const
    }))
    void refreshAvailableSkills(set, get)
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
          ...deriveSubagentStateFromToolCalls(
            payload.toolCallsByThread,
            state.subagentStateById,
            state.subagentProgressTimelineByThread
          ),
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
          folders: payload.folders ?? [],
          toolCalls: payload.toolCallsByThread
        }))
        set((state) => deriveActiveThreadRunState(state))

        const initialActiveThreadId = useAppStore.getState().activeThreadId
        if (initialActiveThreadId && window.api?.yachiyo?.loadThreadData) {
          const data = await window.api.yachiyo.loadThreadData({ threadId: initialActiveThreadId })
          set((state) => ({
            ...(data.runs
              ? { runsByThread: { ...state.runsByThread, [initialActiveThreadId]: data.runs } }
              : {})
          }))
        }

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

  createFolderForThreads: async (threadIds) => {
    await window.api.yachiyo.createFolderForThreads({ threadIds })
  },

  renameFolder: async (folderId, title) => {
    await window.api.yachiyo.renameFolder({ folderId, title })
  },

  setFolderColor: async (folderId, colorTag) => {
    await window.api.yachiyo.setFolderColor({ folderId, colorTag })
  },

  deleteFolder: async (folderId) => {
    await window.api.yachiyo.deleteFolder({ folderId })
  },

  moveThreadToFolder: async (threadId, folderId) => {
    await window.api.yachiyo.moveThreadToFolder({ threadId, folderId })
  },

  toggleFolderCollapsed: (folderId) => {
    set((state) => {
      const next = new Set(state.collapsedFolderIds)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return { collapsedFolderIds: next }
    })
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
    clearRecapForThread(set, get, threadId)

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
    clearRecapForThread(set, get, threadId)

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
    } else if (state.activeEssentialId) {
      set({ pendingModelOverride: { providerName, model } })
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

  sendMessage: async (mode = 'normal', override) => {
    // Guard against accidental double-submits (double Enter, key repeat,
    // Composer remount during steer, etc). Module-level so it survives
    // component lifecycles. Combines an in-flight lock with a content+thread
    // fingerprint within a recency window.
    if (sendInFlight) return false
    const currentState = get()
    const draft = getComposerDraft(currentState)
    const trimmed = override ? override.content.trim() : draft.text.trim()
    const images = override ? override.images : toReadyMessageImages(draft.images)
    const attachments = override ? override.attachments : toReadyFileAttachments(draft.files)

    // Reject locally-invalid drafts BEFORE arming the dedup window. Otherwise
    // an invalid attempt would poison the window and silently drop the user's
    // immediate retry after they fix the draft. The override path (e.g. input
    // buffer flush) carries an already-ready payload so the draft status
    // checks do not apply.
    if (!override) {
      if (
        draft.images.some((image) => image.status === 'loading' || image.status === 'failed') ||
        draft.files.some((file) => file.status === 'loading' || file.status === 'failed') ||
        !hasMessagePayload({ content: trimmed, images, attachments })
      ) {
        return false
      }
    } else if (!hasMessagePayload({ content: trimmed, images, attachments })) {
      return false
    }

    const fingerprint = JSON.stringify({
      t: currentState.activeThreadId,
      m: mode,
      c: trimmed,
      iN: images.length,
      aN: attachments.length
    })
    const fpNow = Date.now()
    if (
      trimmed.length > 0 &&
      lastSendFingerprint === fingerprint &&
      fpNow - lastSendAt < SEND_DEDUP_WINDOW_MS
    ) {
      return false
    }
    lastSendFingerprint = fingerprint
    lastSendAt = fpNow
    sendInFlight = true
    if (currentState.activeThreadId) {
      clearRecapForThread(set, get, currentState.activeThreadId)
    }
    try {
      const enabledTools = currentState.enabledTools
      const enabledSkillNames = override
        ? normalizeSkillNames(override.enabledSkillNames ?? currentState.config?.skills?.enabled)
        : resolveEffectiveEnabledSkillNames({
            config: currentState.config,
            draft
          })
      // Whether the caller explicitly scoped skills (null = use defaults).
      // Mirrors the draft.enabledSkillNames !== null semantics for overrides.
      const hasExplicitSkillNames = override
        ? override.enabledSkillNames !== undefined && override.enabledSkillNames !== null
        : draft.enabledSkillNames !== null

      // Override carries an explicit threadId; never fall back to
      // activeThreadId for override sends, so the payload cannot be
      // delivered into a thread the user switched to mid-flush.
      let threadId: string | null = override ? override.threadId : currentState.activeThreadId
      const workspacePath = normalizeWorkspacePath(
        threadId
          ? currentState.threads.find((thread) => thread.id === threadId)?.workspacePath
          : currentState.pendingWorkspacePath
      )

      if (!threadId && mode !== 'normal') {
        return false
      }

      if (!threadId) {
        const essentialId = currentState.activeEssentialId
        const essential = essentialId
          ? currentState.config?.essentials?.find((entry) => entry.id === essentialId)
          : undefined
        const pendingModel = currentState.pendingModelOverride
        const pendingAcp = currentState.pendingAcpBinding
        const thread = await window.api.yachiyo.createThread({
          ...(workspacePath ? { workspacePath } : {}),
          ...(essentialId ? { createdFromEssentialId: essentialId } : {}),
          ...(essential?.privacyMode ? { privacyMode: true } : {})
        })

        // Commit local state first so the thread is visible even if setup calls fail.
        if (pendingModel) thread.modelOverride = pendingModel
        if (pendingAcp) thread.runtimeBinding = pendingAcp
        if (essential?.privacyMode) {
          thread.privacyMode = true
        }
        if (essential?.icon && essential.iconType === 'emoji') {
          thread.icon = essential.icon
        }

        set((state) => ({
          activeThreadId: thread.id,
          activeEssentialId: null,
          pendingModelOverride: null,
          pendingAcpBinding: null,
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

        // Best-effort: persist model/icon to server. Failures are non-fatal —
        // the thread is already stored locally with the correct values.
        if (pendingModel) {
          window.api.yachiyo
            .setThreadModelOverride({ threadId: thread.id, modelOverride: pendingModel })
            .catch(() => {})
        }
        if (essential?.icon && essential.iconType === 'emoji') {
          window.api.yachiyo
            .setThreadIcon({ threadId: thread.id, icon: essential.icon })
            .catch(() => {})
        }

        // ACP binding must be persisted server-side before sendChat, because the
        // run router reads it from storage to decide whether to use the ACP path.
        if (pendingAcp) {
          const updatedThread = await window.api.yachiyo.setThreadRuntimeBinding({
            threadId: thread.id,
            runtimeBinding: pendingAcp
          })
          set((s) => ({ threads: upsertThread(s.threads, updatedThread) }))
        }
      }

      const editingMessage = currentState.editingMessage
      const isEditMode =
        !override &&
        mode === 'normal' &&
        editingMessage !== null &&
        editingMessage.threadId === threadId

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
                mode === 'follow-up' || hasExplicitSkillNames ? enabledSkillNames : undefined,
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

          const nextMessages =
            acceptedKind === 'active-run-steer-pending'
              ? (state.messages[accepted.thread.id] ?? [])
              : replaceMessage(
                  state.messages[accepted.thread.id] ?? [],
                  acceptedUserMessage as Message,
                  acceptedReplacedMessageId
                )

          // Edit mode deletes the targeted message and all its descendants
          // (plus their tool calls / harness events) before starting a fresh
          // run. The authoritative cleanup arrives via thread.state.replaced,
          // but if that event races with this acceptance handler, stale tool
          // calls from the deleted subtree can linger. Compute the deleted
          // descendant IDs and filter them out here.
          let nextToolCalls = state.toolCalls
          let nextHarnessEvents = state.harnessEvents
          if (isEditMode && acceptedReplacedMessageId) {
            const currentMessages = state.messages[accepted.thread.id] ?? []
            const deletedIds = collectDescendantIds(currentMessages, acceptedReplacedMessageId)
            const filteredToolCalls = (state.toolCalls[accepted.thread.id] ?? []).filter(
              (tc) => !tc.requestMessageId || !deletedIds.has(tc.requestMessageId)
            )
            nextToolCalls = { ...state.toolCalls, [accepted.thread.id]: filteredToolCalls }
            const survivingRunIds = new Set(filteredToolCalls.map((tc) => tc.runId).filter(Boolean))
            const filteredHarnesses = (state.harnessEvents[accepted.thread.id] ?? []).filter((h) =>
              survivingRunIds.has(h.runId)
            )
            nextHarnessEvents = { ...state.harnessEvents, [accepted.thread.id]: filteredHarnesses }
          }

          const nextState = {
            ...state,
            activeRequestMessageIdsByThread: nextActiveRequestMessageIdsByThread,
            activeRunIdsByThread: nextActiveRunIdsByThread,
            activeThreadId: accepted.thread.id,
            archivedThreads: removeThread(state.archivedThreads, accepted.thread.id),
            // Preserve the live draft when the payload came from an override
            // (e.g. input buffer flush). The user may already be typing the
            // next message into the composer while the buffered one is
            // sending, and that text must not be discarded.
            composerDrafts: override
              ? state.composerDrafts
              : removeComposerDraft(state.composerDrafts, accepted.thread.id),
            // Buffered flushes are unrelated to any active edit — do not
            // silently abandon an edit the user started after staging.
            editingMessage: override ? state.editingMessage : null,
            lastError: null,
            messages: {
              ...state.messages,
              [accepted.thread.id]: nextMessages
            },
            toolCalls: nextToolCalls,
            harnessEvents: nextHarnessEvents,
            pendingSteerMessages:
              acceptedKind === 'active-run-steer-pending'
                ? {
                    ...state.pendingSteerMessages,
                    [accepted.thread.id]: appendPendingSteer(
                      state.pendingSteerMessages[accepted.thread.id],
                      trimmed,
                      images,
                      draft.files.filter((f) => f.status === 'ready'),
                      draft.enabledSkillNames ?? null
                    )
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
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to send the message.'
        // Clear the dedup fingerprint so the user can immediately retry the
        // same prompt after a transient failure.
        lastSendFingerprint = null
        lastSendAt = 0
        set({
          activeThreadId: threadId,
          lastError: message,
          runStatus: 'failed'
        })
        return false
      }
    } finally {
      sendInFlight = false
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
    const { messages } = get()

    set((state) => {
      const nextState = {
        ...state,
        activeThreadId: id,
        activeEssentialId: null,
        pendingModelOverride: null,
        pendingAcpBinding: null,
        pendingWorkspacePath: null,
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

    // Load thread data on-demand. Messages and tool calls are loaded only when
    // not yet in memory; runs are always refreshed so the run history sidebar
    // shows the full list from the database.
    if (typeof window !== 'undefined' && window.api?.yachiyo?.loadThreadData) {
      const needsMessages = !messages[id]?.length
      if (needsMessages) {
        console.log(`[setActiveThread] loading thread data for ${id}`)
      }
      void window.api.yachiyo.loadThreadData({ threadId: id }).then((data) => {
        set((state) => {
          const toolCalls = needsMessages
            ? { ...state.toolCalls, [id]: data.toolCalls }
            : state.toolCalls
          return {
            ...(needsMessages ? { messages: { ...state.messages, [id]: data.messages } } : {}),
            toolCalls,
            ...(data.runs ? { runsByThread: { ...state.runsByThread, [id]: data.runs } } : {}),
            ...deriveSubagentStateFromToolCalls(
              toolCalls,
              state.subagentStateById,
              state.subagentProgressTimelineByThread
            )
          }
        })
      })
    }
  },
  setScrollToMessageId: (messageId) => set({ scrollToMessageId: messageId }),
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

  setActiveArchivedThread: (id) => {
    set({ activeArchivedThreadId: id, threadListMode: 'archived' })
    // Mark as read when the user opens an archived thread.
    void window.api.yachiyo.markThreadAsRead({ threadId: id }).then((updated) => {
      set((state) => ({
        archivedThreads: state.archivedThreads.map((t) => (t.id === id ? updated : t))
      }))
    })
  },

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

  toggleShowExternalThreads: () => {
    const { showExternalThreads } = get()
    if (!showExternalThreads) {
      void window.api.yachiyo.listExternalThreads().then((records) => {
        set({ externalThreads: records, showExternalThreads: true })
      })
    } else {
      set({ externalThreads: [], showExternalThreads: false })
    }
  },

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

  mergeBufferedPayloadIntoDraft: (payload, targetThreadId) =>
    set((state) => {
      const draftKey = getComposerDraftKey(
        targetThreadId !== undefined ? targetThreadId : state.activeThreadId
      )
      const makeId = (): string =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`

      const newImageDrafts: ComposerImageDraft[] = payload.images.map((img) => ({
        id: makeId(),
        dataUrl: img.dataUrl,
        mediaType: img.mediaType,
        ...(img.filename !== undefined ? { filename: img.filename } : {}),
        status: 'ready'
      }))
      const newFileDrafts: ComposerFileDraft[] = payload.attachments.map((att) => ({
        id: makeId(),
        filename: att.filename,
        mediaType: att.mediaType,
        dataUrl: att.dataUrl,
        status: 'ready'
      }))

      return {
        composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => {
          // Buffered content predates the live draft; prepend it with a
          // newline so both segments remain editable and in order.
          const mergedText =
            draft.text.length > 0 && payload.content.length > 0
              ? `${payload.content}\n${draft.text}`
              : payload.content.length > 0
                ? payload.content
                : draft.text
          // Keep the live draft's skill selection. The staged payload predates
          // the current draft, so if the user adjusted skills for the new
          // draft those choices must win; on send, the merged content will be
          // scoped by the selection that is live at that moment.
          return {
            ...draft,
            text: mergedText,
            images: [...draft.images, ...newImageDrafts],
            files: [...draft.files, ...newFileDrafts]
          }
        })
      }
    }),

  setPendingAcpBinding: (binding) => {
    set({ pendingAcpBinding: binding })
  },

  setPendingWorkspacePath: (workspacePath) => {
    set({
      pendingWorkspacePath: normalizeWorkspacePath(workspacePath)
    })
    void refreshAvailableSkills(set, get)
  },

  setThreadWorkspace: async (workspacePath, targetThreadId) => {
    const threadId = targetThreadId ?? get().activeThreadId
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
      set((state) => {
        const nextState: Partial<AppState> = {
          lastError: null
        }

        if (isExternalThread(thread)) {
          nextState.externalThreads = sortThreads([
            thread,
            ...state.externalThreads.filter((item) => item.id !== thread.id)
          ])
        } else {
          nextState.threads = upsertThread(state.threads, thread)
        }

        return nextState
      })
      if (get().activeThreadId === threadId) {
        await refreshAvailableSkills(set, get)
      }
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
