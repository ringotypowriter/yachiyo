import type {
  ComposerReasoningSelection,
  FolderRecord,
  Message,
  MessageImageRecord,
  MessageTextBlockRecord,
  ProviderSettings,
  RunRecord,
  RunStatus,
  SendChatAttachment,
  SettingsConfig,
  Thread,
  ToolCall,
  ToolCallName
} from '../../types.ts'
import { normalizeMessageImages } from '../../../../../shared/yachiyo/messageContent.ts'
import {
  normalizeSkillNames,
  USER_MANAGED_TOOL_NAMES
} from '../../../../../shared/yachiyo/protocol.ts'
import { sortToolCallsChronologically } from '../../../../../shared/yachiyo/toolCallOrder.ts'
import { getReasoningSelectorState } from '../../../../../shared/yachiyo/reasoningEffort.ts'
import { collectMessagePath } from '../../../../../shared/yachiyo/threadTree.ts'
import { isExternalThread } from '../../../features/threads/lib/threadVisibility.ts'
import type {
  ActiveSubagentState,
  AppState,
  ComposerDraft,
  ComposerFileDraft,
  ComposerImageDraft,
  GlobalProcessingTask,
  PendingAssistantMessage,
  PendingSteerMessage,
  PendingSteerSegment,
  SidebarFilter,
  SubagentProgressEntry
} from '../useAppStore.ts'

const COLLAPSED_FOLDER_IDS_KEY = 'yachiyo.collapsedFolderIds'
const SIDEBAR_FILTER_KEY = 'yachiyo.sidebarFilter'

export const DEFAULT_SIDEBAR_FILTER: SidebarFilter = {
  base: 'all',
  colorTags: new Set(),
  workspacePaths: new Set(),
  running: false,
  justDone: false,
  folderOnly: false
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: '',
  images: [],
  files: [],
  enabledSkillNames: null
}

const NOTIFICATION_DEDUPE_WINDOW_MS = 10_000
export const DEFAULT_GLOBAL_PROCESSING_LABEL = 'Please wait...'
const recentNotificationKeys = new Map<string, number>()
let globalProcessingTaskSequence = 0
let availableSkillsRequestId = 0

export function hasActiveMultiFilter(filter: SidebarFilter): boolean {
  return (
    filter.colorTags.size > 0 ||
    filter.workspacePaths.size > 0 ||
    filter.running ||
    filter.justDone ||
    filter.folderOnly
  )
}

export function deriveThreadListMode(filter: SidebarFilter): 'active' | 'archived' {
  if (hasActiveMultiFilter(filter)) return 'active'
  return filter.base === 'archived' ? 'archived' : 'active'
}

export function withFilterBase(
  sidebarFilter: SidebarFilter,
  base: 'all' | 'archived'
): { threadListMode: 'active' | 'archived'; sidebarFilter: SidebarFilter } {
  const next = { ...sidebarFilter, base }
  return { threadListMode: base === 'archived' ? 'archived' : 'active', sidebarFilter: next }
}

export function loadSidebarFilter(): SidebarFilter {
  try {
    const raw = localStorage.getItem(SIDEBAR_FILTER_KEY)
    if (!raw) return DEFAULT_SIDEBAR_FILTER
    const parsed = JSON.parse(raw)
    return {
      base: parsed.base === 'archived' ? 'archived' : 'all',
      colorTags: new Set(Array.isArray(parsed.colorTags) ? parsed.colorTags : []),
      workspacePaths: new Set(Array.isArray(parsed.workspacePaths) ? parsed.workspacePaths : []),
      running: Boolean(parsed.running),
      justDone: Boolean(parsed.justDone),
      folderOnly: Boolean(parsed.folderOnly)
    }
  } catch {
    return DEFAULT_SIDEBAR_FILTER
  }
}

export function saveSidebarFilter(filter: SidebarFilter): void {
  try {
    localStorage.setItem(
      SIDEBAR_FILTER_KEY,
      JSON.stringify({
        base: filter.base,
        colorTags: [...filter.colorTags],
        workspacePaths: [...filter.workspacePaths],
        running: filter.running,
        justDone: filter.justDone,
        folderOnly: filter.folderOnly
      })
    )
  } catch {
    // ignore storage errors
  }
}

export function loadCollapsedFolderIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDER_IDS_KEY)
    if (!raw) return new Set<string>()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return new Set<string>(parsed.filter((id): id is string => typeof id === 'string'))
    }
  } catch {
    // ignore corrupt storage
  }
  return new Set<string>()
}

export function saveCollapsedFolderIds(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_FOLDER_IDS_KEY, JSON.stringify([...ids]))
  } catch {
    // ignore storage errors
  }
}

export function removeReasoning(message: Message): Message {
  const nextMessage = { ...message }
  delete nextMessage.reasoning
  return nextMessage
}

export function shouldShowNotification(key: string): boolean {
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

export function createGlobalProcessingTask(label: string): GlobalProcessingTask {
  globalProcessingTaskSequence += 1
  return {
    id: `global-processing:${globalProcessingTaskSequence}`,
    label
  }
}

export function waitForGlobalProcessingPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutId = null
      resolve()
    }, 80)

    const resolveOnce = (): void => {
      if (timeoutId === null) return
      clearTimeout(timeoutId)
      timeoutId = null
      resolve()
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolveOnce)
    })
  })
}

export async function refreshAvailableSkills(
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

export function clearRecapForThread(
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

export function areEnabledToolsEqual(left: ToolCallName[], right: ToolCallName[]): boolean {
  return left.length === right.length && left.every((toolName, index) => toolName === right[index])
}

export function toggleEnabledTools(
  enabledTools: ToolCallName[],
  toolName: ToolCallName
): ToolCallName[] {
  if (enabledTools.includes(toolName)) {
    return enabledTools.filter((currentToolName) => currentToolName !== toolName)
  }

  const nextEnabledTools = new Set([...enabledTools, toolName])
  return USER_MANAGED_TOOL_NAMES.filter((currentToolName) => nextEnabledTools.has(currentToolName))
}

export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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

export function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  if (isExternalThread(thread)) return threads
  return sortThreads([thread, ...threads.filter((item) => item.id !== thread.id)])
}

export function collectThreadReasoningEfforts(
  threads: Thread[]
): Record<string, ComposerReasoningSelection> {
  return Object.fromEntries(
    threads
      .filter((thread) => thread.reasoningEffort !== undefined)
      .map((thread) => [thread.id, thread.reasoningEffort!] as const)
  )
}

export function setReasoningEffortValue(
  values: Record<string, ComposerReasoningSelection>,
  threadId: string,
  reasoningEffort: ComposerReasoningSelection | undefined
): Record<string, ComposerReasoningSelection> {
  if (reasoningEffort === undefined) {
    if (!(threadId in values)) return values
    const next = { ...values }
    delete next[threadId]
    return next
  }

  if (values[threadId] === reasoningEffort) return values
  return { ...values, [threadId]: reasoningEffort }
}

export function removeThread(threads: Thread[], threadId: string): Thread[] {
  return threads.filter((thread) => thread.id !== threadId)
}

export function upsertFolder(folders: FolderRecord[], folder: FolderRecord): FolderRecord[] {
  return [folder, ...folders.filter((f) => f.id !== folder.id)]
}

export function removeFolder(folders: FolderRecord[], folderId: string): FolderRecord[] {
  return folders.filter((f) => f.id !== folderId)
}

export function upsertMessage(messages: Message[], message: Message): Message[] {
  const next = [...messages.filter((item) => item.id !== message.id), message]
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function appendTextBlockDelta(input: {
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

export function replaceMessage(
  messages: Message[],
  message: Message,
  replacedMessageId?: string
): Message[] {
  const next = replacedMessageId
    ? messages.filter((item) => item.id !== replacedMessageId)
    : messages

  return upsertMessage(next, message)
}

export function upsertToolCall(toolCalls: ToolCall[], toolCall: ToolCall): ToolCall[] {
  const next = [...toolCalls.filter((item) => item.id !== toolCall.id), toolCall]
  return sortToolCallsChronologically(next)
}

export function upsertActiveSubagentId(
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

export function removeActiveSubagentId(
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

export function appendSubagentProgressEntry(
  progressByThread: Record<string, SubagentProgressEntry[]>,
  threadId: string,
  entry: SubagentProgressEntry
): Record<string, SubagentProgressEntry[]> {
  return {
    ...progressByThread,
    [threadId]: [...(progressByThread[threadId] ?? []), entry]
  }
}

export function deriveSubagentStateFromToolCalls(
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

export function syncSubagentStateWithToolCall(input: {
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

export function terminateRunToolCalls(
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

export function upsertLatestRun(
  latestRunsByThread: Record<string, RunRecord>,
  run: RunRecord
): Record<string, RunRecord> {
  return {
    ...latestRunsByThread,
    [run.threadId]: run
  }
}

export const RUN_TOKEN_FIELD_NAMES = [
  'promptTokens',
  'completionTokens',
  'totalPromptTokens',
  'totalCompletionTokens',
  'cacheReadTokens',
  'cacheWriteTokens'
] as const

export function stripRunTokens(run: RunRecord): RunRecord {
  return Object.fromEntries(
    Object.entries(run).filter(
      ([key]) => !RUN_TOKEN_FIELD_NAMES.includes(key as (typeof RUN_TOKEN_FIELD_NAMES)[number])
    )
  ) as RunRecord
}

export function stripLatestRunTokens(
  latestRunsByThread: Record<string, RunRecord>,
  threadId: string
): Record<string, RunRecord> {
  const existing = latestRunsByThread[threadId]
  if (!existing) return latestRunsByThread
  const stripped = stripRunTokens(existing)
  return {
    ...latestRunsByThread,
    [threadId]: stripped
  }
}

export function upsertRunRecord(runs: RunRecord[], run: RunRecord): RunRecord[] {
  const next = [...runs.filter((entry) => entry.id !== run.id), run]
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function updateRunRecord(
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

export function bootstrapRunsByThread(
  latestRunsByThread: Record<string, RunRecord>
): Record<string, RunRecord[]> {
  return Object.fromEntries(
    Object.values(latestRunsByThread).map((run) => [run.threadId, [run]] as const)
  )
}

export const NEW_THREAD_DRAFT_KEY = '__new__'
export const DEFAULT_THREAD_TITLE = 'New Chat'

export function getComposerDraftKey(threadId: string | null): string {
  return threadId ?? NEW_THREAD_DRAFT_KEY
}

export function getComposerDraft(
  state: Pick<AppState, 'activeThreadId' | 'composerDrafts'>
): ComposerDraft {
  return state.composerDrafts[getComposerDraftKey(state.activeThreadId)] ?? EMPTY_COMPOSER_DRAFT
}

export function getComposerReasoningEffort(
  state: Pick<
    AppState,
    | 'activeThreadId'
    | 'config'
    | 'pendingModelOverride'
    | 'reasoningEffortByThread'
    | 'settings'
    | 'threads'
  >,
  threadId: string | null = state.activeThreadId
): ComposerReasoningSelection {
  const key = getComposerDraftKey(threadId)
  const persisted = threadId
    ? state.threads.find((thread) => thread.id === threadId)?.reasoningEffort
    : undefined
  const selected = state.reasoningEffortByThread[key] ?? persisted
  const effectiveModel = threadId
    ? getThreadEffectiveModel(state, threadId)
    : getEffectiveModel(state)
  const provider = state.config?.providers.find(
    (entry) => entry.name === effectiveModel.providerName
  )

  if (!provider) {
    return selected ?? 'medium'
  }

  return getReasoningSelectorState({
    provider,
    model: effectiveModel.model,
    selected
  }).selected
}

export function getThreadActiveRunId(
  state: Pick<AppState, 'activeRunIdsByThread'>,
  threadId: string | null
): string | null {
  if (!threadId) {
    return null
  }

  return state.activeRunIdsByThread[threadId] ?? null
}

export function getThreadActiveRequestMessageId(
  state: Pick<AppState, 'activeRequestMessageIdsByThread'>,
  threadId: string | null
): string | null {
  if (!threadId) {
    return null
  }

  return state.activeRequestMessageIdsByThread[threadId] ?? null
}

export function getThreadRunPhase(
  state: Pick<AppState, 'runPhasesByThread'>,
  threadId: string | null
): AppState['runPhase'] {
  if (!threadId) {
    return 'idle'
  }

  return state.runPhasesByThread[threadId] ?? 'idle'
}

export function getThreadRunStatus(
  state: Pick<AppState, 'runStatusesByThread'>,
  threadId: string | null
): RunStatus {
  if (!threadId) {
    return 'idle'
  }

  return state.runStatusesByThread[threadId] ?? 'idle'
}

export function deriveActiveThreadRunState(
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

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.enabledSkillNames === null
  )
}

export function isThreadReusableNewChat(
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

export function isBlankNewChat(input: Pick<AppState, 'messages'>, thread: Thread): boolean {
  return (
    thread.title === DEFAULT_THREAD_TITLE &&
    (input.messages[thread.id] ?? []).length === 0 &&
    !thread.preview &&
    !thread.headMessageId
  )
}

export function upsertComposerDraft(
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

export function updateComposerDraft(
  drafts: Record<string, ComposerDraft>,
  draftKey: string,
  updater: (draft: ComposerDraft) => ComposerDraft
): Record<string, ComposerDraft> {
  return upsertComposerDraft(drafts, draftKey, updater(drafts[draftKey] ?? EMPTY_COMPOSER_DRAFT))
}

export function moveComposerDraft(
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

export function moveReasoningEffort(
  values: Record<string, ComposerReasoningSelection>,
  fromDraftKey: string,
  toDraftKey: string
): Record<string, ComposerReasoningSelection> {
  if (fromDraftKey === toDraftKey || !(fromDraftKey in values)) {
    return values
  }

  const next = { ...values }
  next[toDraftKey] = values[fromDraftKey]!
  delete next[fromDraftKey]
  return next
}

export function removeComposerDraft(
  drafts: Record<string, ComposerDraft>,
  threadId: string | null
): Record<string, ComposerDraft> {
  const next = { ...drafts }
  delete next[getComposerDraftKey(threadId)]
  return next
}

export function buildPendingSteerFromSegments(
  segments: PendingSteerSegment[]
): PendingSteerMessage {
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

export function appendPendingSteer(
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

export function removePendingSteerMessage(
  pendingSteerMessages: Record<string, PendingSteerMessage>,
  threadId: string
): Record<string, PendingSteerMessage> {
  const next = { ...pendingSteerMessages }
  delete next[threadId]
  return next
}

export function removeThreadRetryInfo(
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

export function setThreadStringValue(
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

export function setThreadRunPhaseValue(
  values: AppState['runPhasesByThread'],
  threadId: string,
  value: AppState['runPhase']
): AppState['runPhasesByThread'] {
  return {
    ...values,
    [threadId]: value
  }
}

export function setThreadRunStatusValue(
  values: AppState['runStatusesByThread'],
  threadId: string,
  value: RunStatus
): AppState['runStatusesByThread'] {
  return {
    ...values,
    [threadId]: value
  }
}

export function normalizeWorkspacePath(workspacePath: string | null | undefined): string | null {
  const normalized = workspacePath?.trim()
  return normalized ? normalized : null
}

export function resolveEffectiveEnabledSkillNames(input: {
  config: SettingsConfig | null
  draft: ComposerDraft
}): string[] {
  return normalizeSkillNames(input.draft.enabledSkillNames ?? input.config?.skills?.enabled)
}

export function toReadyMessageImages(images: ComposerImageDraft[]): MessageImageRecord[] {
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

export function toReadyFileAttachments(files: ComposerFileDraft[]): SendChatAttachment[] {
  return files
    .filter((file) => file.status === 'ready' && file.dataUrl)
    .map((file) => ({
      filename: file.filename,
      mediaType: file.mediaType,
      dataUrl: file.dataUrl
    }))
}

export function finalizePendingMessage(
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

export function resolveActiveRequestMessageId(
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
