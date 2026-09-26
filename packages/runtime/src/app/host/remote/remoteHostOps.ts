import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { hasPendingPlanDocument, isLatestRunPlanMode } from '@yachiyo/shared/planMode'
import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID,
  normalizeActiveRunEnterBehavior,
  type ActiveRunEnterBehavior,
  type MessageRecord,
  type RunRecord,
  type SettingsConfig,
  type ThreadRecord
} from '@yachiyo/shared/protocol'
import { isModelImageCapable } from '@yachiyo/shared/providerConfig'
import { getReasoningSelectorState } from '@yachiyo/shared/reasoningEffort'
import { REMOTE_THREAD_PAGE_DEFAULT } from '@yachiyo/shared/remote/methods'
import {
  projectMessage,
  projectThreadSummary,
  projectTodoItems,
  projectToolCall,
  workspaceNameOf
} from '@yachiyo/shared/remote/project'
import type {
  RemoteAppearance,
  RemoteEssential,
  RemoteMessage,
  RemoteSearchResult,
  RemoteSelectableModel,
  RemoteTask,
  RemoteThreadDetail,
  RemoteThreadSummary,
  RemoteToolCall,
  RemoteWorkspace
} from '@yachiyo/shared/remote/projections'
import { buildMessageTreeMaps, collectMessagePathFromMaps } from '@yachiyo/shared/threadTree'

import type { YachiyoServer } from '../YachiyoServer.ts'
import { assertPageLimit } from '../../../storage/messagePageWindow.ts'
import { isLocalOrOwnerDmThread } from '../../../storage/threadVisibility.ts'
import { fitRemoteThreadBudgetMeasured } from './remoteThreadBudget.ts'
import { resolveThreadWorkspacePath } from '../../../config/paths.ts'
import { readRemoteWorkspaceFile } from './remoteWorkspaceFile.ts'
import { createEssentialIconCache } from './remoteEssentialIcon.ts'

const THREAD_LIST_DEFAULT = 100
const RECENT_WORKSPACE_LIMIT = 20
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
// A resync pages the whole inbox in a few seconds; sessions outliving that are abandoned.
const PAGING_SESSION_LIMIT = 8
const PAGING_SESSION_TTL_MS = 10 * 60 * 1000

/** The slice of YachiyoServer the remote projections read. */
export type RemoteProjectionServer = Pick<
  YachiyoServer,
  | 'getStorage'
  | 'getConfig'
  | 'getSyncStatus'
  | 'getQueuedFollowUpMessages'
  | 'listSubagents'
  | 'listBackgroundTasks'
  | 'searchThreadsAndMessages'
>

export class RemoteNotFoundError extends Error {
  override name = 'RemoteNotFound'
}

export interface RemoteHostInfo {
  syncDeviceId?: string
  activeRunEnterBehavior: ActiveRunEnterBehavior
}

type ThreadListPage = { threads: RemoteThreadSummary[]; nextCursor?: string }

type LoadThreadInput = {
  threadId: string
  limit?: number
  beforeMessageId?: string
  omitToolPreviews?: boolean
}

/**
 * Whether a thread may reach the phone at all: the inbox trust rule shared with `bootstrap`
 * (local, or an owner DM outside groups), minus read-only sync mirrors. Archiving is not part
 * of it, so the answer is stable for the thread's lifetime.
 */
export function isRemoteVisibleThread(thread: ThreadRecord): boolean {
  return !thread.syncOriginDeviceId && isLocalOrOwnerDmThread(thread, thread.channelUserRole)
}

/** Replaces inline previews with `hasPreview`; `tools.getPreview` serves them on demand. */
export function omitToolPreviews(toolCall: RemoteToolCall): RemoteToolCall {
  if (toolCall.inputPreview === undefined && toolCall.outputPreview === undefined) return toolCall
  const rest = { ...toolCall, hasPreview: true }
  delete rest.inputPreview
  delete rest.outputPreview
  return rest
}

export interface RemoteHostOps {
  'host.remote.listThreadSummaries'(input: { cursor?: string; limit?: number }): ThreadListPage
  'host.remote.getThreadSummary'(input: { threadId: string }): RemoteThreadSummary | null
  /** Stable trust visibility; null when the thread no longer exists. */
  'host.remote.getThreadVisibility'(input: { threadId: string }): boolean | null
  'host.remote.loadThread'(input: LoadThreadInput): RemoteThreadDetail
  /** `loadThread` plus the UTF-8 JSON size of the detail, so callers can extend it cheaply. */
  'host.remote.loadThreadMeasured'(input: LoadThreadInput): {
    detail: RemoteThreadDetail
    byteLength: number
  }
  'host.remote.listRecentWorkspaces'(): { workspaces: RemoteWorkspace[] }
  'host.remote.listSelectableModels'(): Promise<{ models: RemoteSelectableModel[] }>
  'host.remote.listEssentials'(): Promise<{ essentials: RemoteEssential[] }>
  /** One essential without icon versioning, for starting a thread from it. */
  'host.remote.getEssential'(input: { essentialId: string }): Promise<RemoteEssential | null>
  'host.remote.getEssentialIcon'(input: {
    essentialId: string
  }): Promise<{ mediaType: string; data: string; iconVersion: string }>
  'host.remote.getFile'(input: {
    threadId: string
    path: string
  }): Promise<{ filename: string; mediaType: string; data: string }>
  'host.remote.getAppearance'(): Promise<RemoteAppearance>
  'host.remote.getHostInfo'(): Promise<RemoteHostInfo>
  'host.remote.listTasks'(input: { threadId: string }): Promise<{ tasks: RemoteTask[] }>
  'host.remote.getImage'(input: { threadId: string; messageId: string; imageId: string }): {
    mediaType: string
    data: string
  }
  'host.remote.search'(input: { query: string; scope?: 'active' | 'archived' }): {
    results: RemoteSearchResult[]
  }
  'host.remote.getToolPreview'(input: { threadId: string; toolCallId: string }): {
    inputPreview?: string
    outputPreview?: string
    truncated: boolean
  }
}

/**
 * Read-only projections behind `host.remote.*`. They run in the runtime process so path
 * computation and truncation never happen on the main thread, and nothing here reads
 * provider credentials: settings are only consulted for model names, essentials, and theme.
 */
export function createRemoteHostOps(server: RemoteProjectionServer): RemoteHostOps {
  const storage = (): ReturnType<YachiyoServer['getStorage']> => server.getStorage()
  let syncDeviceIdPromise: Promise<string | undefined> | null = null
  const essentialIcons = createEssentialIconCache()
  // Inbox paging sessions: the visible thread order captured by the first page, so later
  // pages neither re-run `bootstrap()` nor skip/duplicate threads that move meanwhile.
  const pagingSessions = new Map<string, { threadIds: string[]; createdAt: number }>()

  function attentionFor(thread: ThreadRecord, latestRun: RunRecord | undefined): boolean {
    if (!latestRun) return false
    if (latestRun.status === 'running') {
      return storage().hasThreadWaitingToolCall(thread.id)
    }
    if (latestRun.status !== 'completed' || latestRun.runMode !== 'plan') return false
    return hasPendingPlanDocument({
      messages: storage().listThreadMessages(thread.id, { includeResponseMessages: false }),
      toolCalls: storage().listThreadToolCalls(thread.id)
    })
  }

  function summarize(thread: ThreadRecord, latestRun: RunRecord | undefined): RemoteThreadSummary {
    return projectThreadSummary(thread, {
      ...(latestRun ? { latestRun } : {}),
      needsAttention: attentionFor(thread, latestRun)
    })
  }

  function latestRunOf(threadId: string): RunRecord | undefined {
    return storage().listThreadRuns(threadId, { limit: 1 })[0]
  }

  function visibleInInbox(thread: ThreadRecord, latestRun: RunRecord | undefined): boolean {
    return (
      thread.title !== 'New Chat' ||
      Boolean(thread.preview || thread.headMessageId) ||
      latestRun?.status === 'running'
    )
  }

  function requireActiveThread(threadId: string): ThreadRecord {
    const thread = storage().getThread(threadId)
    if (!thread || thread.archivedAt || !isRemoteVisibleThread(thread))
      throw new RemoteNotFoundError('Thread not found.')
    return thread
  }

  /** The inbox as `bootstrap()` lists it; also runs its backfills, like the desktop does. */
  function listInboxThreads(): Array<{ thread: ThreadRecord; latestRun?: RunRecord }> {
    const { threads, latestRunsByThread } = storage().bootstrap()
    return threads
      .filter(
        (thread) =>
          isRemoteVisibleThread(thread) && visibleInInbox(thread, latestRunsByThread[thread.id])
      )
      .map((thread) => ({ thread, latestRun: latestRunsByThread[thread.id] }))
  }

  function openPagingSession(threadIds: string[]): string {
    const now = Date.now()
    for (const [id, session] of pagingSessions) {
      if (now - session.createdAt > PAGING_SESSION_TTL_MS) pagingSessions.delete(id)
    }
    while (pagingSessions.size >= PAGING_SESSION_LIMIT) {
      pagingSessions.delete(pagingSessions.keys().next().value!)
    }
    const id = randomUUID()
    pagingSessions.set(id, { threadIds, createdAt: now })
    return id
  }

  function pageFrom(
    threadIds: string[],
    offset: number,
    limit: number,
    sessionId: string | null
  ): { page: string[]; nextCursor?: string } {
    const page = threadIds.slice(offset, offset + limit)
    const next = offset + page.length
    if (next >= threadIds.length) {
      if (sessionId) pagingSessions.delete(sessionId)
      return { page }
    }
    const id = sessionId ?? openPagingSession(threadIds)
    return { page, nextCursor: `${id}:${next}` }
  }

  function listThreadSummaries(input: { cursor?: string; limit?: number }): ThreadListPage {
    const limit = input.limit ?? THREAD_LIST_DEFAULT
    const cursor = input.cursor ? /^(?:([0-9a-f-]{36}):)?(\d+)$/.exec(input.cursor) : null
    if (input.cursor && !cursor) throw new Error('Invalid thread list cursor.')
    const offset = cursor ? Number.parseInt(cursor[2]!, 10) : 0
    if (!Number.isSafeInteger(offset)) throw new Error('Invalid thread list cursor.')
    const sessionId = cursor?.[1] ?? null
    const session = sessionId ? pagingSessions.get(sessionId) : undefined

    if (!session) {
      // First page, a legacy offset cursor, or an expired session: take a fresh snapshot.
      const inbox = listInboxThreads()
      const { page, nextCursor } = pageFrom(
        inbox.map((entry) => entry.thread.id),
        offset,
        limit,
        null
      )
      const byId = new Map(inbox.map((entry) => [entry.thread.id, entry]))
      return {
        threads: page.map((id) => summarize(byId.get(id)!.thread, byId.get(id)!.latestRun)),
        ...(nextCursor ? { nextCursor } : {})
      }
    }

    // Later pages read only their own threads, current as of this page. Threads archived or
    // hidden since the snapshot are skipped; new ones reach the phone as live summaries.
    const { page, nextCursor } = pageFrom(session.threadIds, offset, limit, sessionId)
    const threads: RemoteThreadSummary[] = []
    for (const id of page) {
      const summary = getThreadSummary({ threadId: id })
      if (summary) threads.push(summary)
    }
    return { threads, ...(nextCursor ? { nextCursor } : {}) }
  }

  function getThreadSummary(input: { threadId: string }): RemoteThreadSummary | null {
    const thread = storage().getThread(input.threadId)
    if (!thread || thread.archivedAt || !isRemoteVisibleThread(thread)) return null
    const latestRun = latestRunOf(thread.id)
    return visibleInInbox(thread, latestRun) ? summarize(thread, latestRun) : null
  }

  function getThreadVisibility(input: { threadId: string }): boolean | null {
    const thread =
      storage().getThread(input.threadId) ?? storage().getArchivedThread(input.threadId)
    return thread ? isRemoteVisibleThread(thread) : null
  }

  function loadThread(input: LoadThreadInput): RemoteThreadDetail {
    return loadThreadMeasured(input).detail
  }

  function loadThreadMeasured(input: LoadThreadInput): {
    detail: RemoteThreadDetail
    byteLength: number
  } {
    const thread = requireActiveThread(input.threadId)
    const limit = input.limit ?? REMOTE_THREAD_PAGE_DEFAULT
    assertPageLimit(limit)
    // O(thread size) lightweight topology preserves off-branch siblings, hidden ancestors,
    // missing parents and cycle handling without reading historical message bodies.
    const topology = storage().listThreadMessageTopology(thread.id)
    const maps = buildMessageTreeMaps(topology)
    const headId = thread.headMessageId ?? topology.at(-1)?.id
    const path = headId ? collectMessagePathFromMaps(maps, headId) : []
    const visiblePath = path.filter((message) => !message.hidden)

    let end = visiblePath.length
    if (input.beforeMessageId) {
      end = visiblePath.findIndex((message) => message.id === input.beforeMessageId)
      if (end < 0) throw new RemoteNotFoundError('Message not found on the current branch.')
    }
    const start = Math.max(0, end - limit)
    const pageNodes = visiblePath.slice(start, end)
    const pageIds = pageNodes.map((message) => message.id)
    const messages = storage().listThreadMessages(thread.id, {
      includeResponseMessages: false,
      messageIds: pageIds
    })
    const byId = new Map(messages.map((message) => [message.id, message]))
    // SQL returns chronological rows; render in ancestry order, not timestamp order.
    const page = pageNodes.flatMap((node) => byId.get(node.id) ?? [])
    const latestRun = latestRunOf(thread.id)
    const activeRun = latestRun?.status === 'running' ? latestRun : undefined
    const toolCalls = storage().listThreadToolCalls(thread.id, {
      messageIds: pageIds,
      activeRunId: activeRun?.id
    })
    const queuedFollowUpMessages = server.getQueuedFollowUpMessages(thread)

    const projected = page
      .map((message) =>
        projectMessage(
          message,
          (maps.childrenByParent.get(message.parentMessageId ?? null) ?? []).map(
            (sibling) => sibling.id
          )
        )
      )
      .filter((message): message is RemoteMessage => message !== null)

    // Legacy runs infer plan mode from the request. At most one extra body is read,
    // without provider responses; active runs do not need this pending-plan check.
    const requestMessages =
      !activeRun &&
      latestRun?.requestMessageId &&
      latestRun.runMode !== 'plan' &&
      !byId.has(latestRun.requestMessageId)
        ? storage().listThreadMessages(thread.id, {
            includeResponseMessages: false,
            messageIds: [latestRun.requestMessageId]
          })
        : []
    const pendingPlan =
      !activeRun &&
      isLatestRunPlanMode({
        latestRun: latestRun ?? null,
        messages: [...messages, ...requestMessages]
      }) &&
      // Rare plan-mode slow path deliberately retains the canonical nonlocal semantics:
      // exit/acceptance can be on another branch or outside this page.
      hasPendingPlanDocument({
        messages: storage().listThreadMessages(thread.id, { includeResponseMessages: false }),
        toolCalls: storage().listThreadToolCalls(thread.id)
      })

    const projectedToolCalls = toolCalls.map(projectToolCall)
    return fitRemoteThreadBudgetMeasured({
      thread: projectThreadSummary(thread, {
        ...(latestRun ? { latestRun } : {}),
        needsAttention:
          (activeRun ? storage().hasThreadWaitingToolCall(thread.id) : false) || pendingPlan
      }),
      messages: projected,
      hasMoreBefore: start > 0,
      toolCalls: input.omitToolPreviews
        ? projectedToolCalls.map(omitToolPreviews)
        : projectedToolCalls,
      queuedFollowUps: queuedFollowUpMessages
        .map((message) => projectMessage(message))
        .filter((message): message is RemoteMessage => message !== null),
      ...(activeRun ? { activeRunId: activeRun.id } : {}),
      ...(activeRun?.runMode && activeRun.runMode !== 'custom'
        ? { activeRunMode: activeRun.runMode }
        : {}),
      pendingPlan,
      todoItems: projectTodoItems(thread.todoItems)
    })
  }

  function listRecentWorkspaces(): { workspaces: RemoteWorkspace[] } {
    const { threads, archivedThreads } = storage().bootstrap()
    const byPath = new Map<string, RemoteWorkspace>()
    for (const thread of [...threads, ...archivedThreads]) {
      const path = thread.workspacePath?.trim()
      if (!path) continue
      const existing = byPath.get(path)
      if (!existing || existing.lastUsedAt < thread.updatedAt) {
        byPath.set(path, {
          path,
          name: workspaceNameOf(path) ?? path,
          lastUsedAt: thread.updatedAt
        })
      }
    }
    return {
      workspaces: [...byPath.values()]
        .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
        .slice(0, RECENT_WORKSPACE_LIMIT)
    }
  }

  async function listSelectableModels(): Promise<{ models: RemoteSelectableModel[] }> {
    const config = await server.getConfig()
    const models: RemoteSelectableModel[] = []
    for (const provider of config.providers) {
      for (const model of provider.modelList.enabled) {
        const reasoning = getReasoningSelectorState({ provider, model })
        models.push({
          providerName: provider.name,
          model,
          isDefault:
            config.defaultModel?.providerName === provider.name &&
            config.defaultModel.model === model,
          imageCapable: isModelImageCapable(config, provider.name, model),
          reasoningEfforts: reasoning.options,
          ...(reasoning.selected ? { defaultReasoningEffort: reasoning.selected } : {})
        })
      }
    }
    return { models }
  }

  async function listEssentials(): Promise<{ essentials: RemoteEssential[] }> {
    const config = await server.getConfig()
    return {
      essentials: await Promise.all(
        [...(config.essentials ?? [])]
          .sort((left, right) => left.order - right.order)
          .map(async (essential) => {
            // Version content, not just the configured path: local files can change in place.
            // HTTP icons remain unversioned so network timeouts never block options metadata.
            // A broken image must not prevent loading the other new-thread options.
            const image =
              essential.iconType === 'image' &&
              essential.icon &&
              (essential.icon.startsWith('data:') ||
                essential.icon.startsWith('file:') ||
                isAbsolute(essential.icon))
                ? await essentialIcons.read(essential.icon).catch(() => undefined)
                : undefined
            return projectEssential(essential, image?.iconVersion)
          })
      )
    }
  }

  async function getEssential(input: { essentialId: string }): Promise<RemoteEssential | null> {
    const config = await server.getConfig()
    const essential = config.essentials?.find((entry) => entry.id === input.essentialId)
    return essential ? projectEssential(essential) : null
  }

  async function getAppearance(): Promise<RemoteAppearance> {
    return appearanceOf(await server.getConfig())
  }

  async function getEssentialIcon(input: {
    essentialId: string
  }): Promise<{ mediaType: string; data: string; iconVersion: string }> {
    const config = await server.getConfig()
    const essential = config.essentials?.find((entry) => entry.id === input.essentialId)
    if (!essential?.icon || essential.iconType !== 'image') {
      throw new RemoteNotFoundError('Essential image not found.')
    }
    return essentialIcons.read(essential.icon)
  }

  async function getFile(input: {
    threadId: string
    path: string
  }): Promise<{ filename: string; mediaType: string; data: string }> {
    const thread = requireActiveThread(input.threadId)
    return readRemoteWorkspaceFile(
      thread.workspacePath || resolveThreadWorkspacePath(thread.id),
      input.path
    )
  }

  async function getHostInfo(): Promise<RemoteHostInfo> {
    const config = await server.getConfig()
    // syncDeviceId only exists once Yachiyo sync is initialized; hello simply omits it otherwise.
    syncDeviceIdPromise ??= server
      .getSyncStatus()
      .then((status) => status.deviceId)
      .catch(() => undefined)
    const syncDeviceId = await syncDeviceIdPromise
    return {
      ...(syncDeviceId ? { syncDeviceId } : {}),
      activeRunEnterBehavior: normalizeActiveRunEnterBehavior(
        config.chat?.activeRunEnterBehavior,
        DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
      )
    }
  }

  async function listTasks(input: { threadId: string }): Promise<{ tasks: RemoteTask[] }> {
    requireActiveThread(input.threadId)
    const subagents = server
      .listSubagents({ threadId: input.threadId })
      .map((agent): RemoteTask => ({
        id: agent.agentId,
        kind: 'subagent',
        title: `${agent.codeName} · ${agent.agentName}`,
        state: agent.state,
        startedAt: agent.startedAt,
        updatedAt: agent.updatedAt,
        ...(agent.progress ? { progress: agent.progress.slice(0, 4096) } : {})
      }))
    const background = (await server.listBackgroundTasks({ threadId: input.threadId })).map(
      (task): RemoteTask => ({
        id: task.taskId,
        kind: 'background',
        title: task.description ?? task.command,
        state: task.status,
        startedAt: task.startedAt,
        ...(task.finishedAt ? { updatedAt: task.finishedAt } : {}),
        ...(task.recentLogTail?.length
          ? { progress: task.recentLogTail.join('\n').slice(-4096) }
          : {})
      })
    )
    return { tasks: [...subagents, ...background] }
  }

  function getImage(input: { threadId: string; messageId: string; imageId: string }): {
    mediaType: string
    data: string
  } {
    requireActiveThread(input.threadId)
    const message: MessageRecord | undefined = storage().getMessage(input.messageId)
    if (!message || message.threadId !== input.threadId) {
      throw new RemoteNotFoundError('Message not found.')
    }
    const image = message.images?.[Number.parseInt(input.imageId, 10)]
    const match = image?.dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
    if (!image || !match) throw new RemoteNotFoundError('Image not found.')
    if ((match[2].length * 3) / 4 > MAX_IMAGE_BYTES) {
      throw new Error('Image is too large to send to the phone.')
    }
    return { mediaType: match[1], data: match[2] }
  }

  function getToolPreview(input: { threadId: string; toolCallId: string }): {
    inputPreview?: string
    outputPreview?: string
    truncated: boolean
  } {
    requireActiveThread(input.threadId)
    const [toolCall] = storage().listThreadToolCalls(input.threadId, {
      messageIds: [],
      toolCallIds: [input.toolCallId]
    })
    if (!toolCall) throw new RemoteNotFoundError('Tool call not found.')
    const { inputPreview, outputPreview, truncated } = projectToolCall(toolCall)
    return {
      ...(inputPreview ? { inputPreview } : {}),
      ...(outputPreview ? { outputPreview } : {}),
      truncated
    }
  }

  function search(input: { query: string; scope?: 'active' | 'archived' }): {
    results: RemoteSearchResult[]
  } {
    return {
      results: server.searchThreadsAndMessages(input).map((result) => ({
        threadId: result.threadId,
        threadTitle: result.threadTitle,
        threadUpdatedAt: result.threadUpdatedAt,
        titleMatched: result.titleMatched,
        messageMatches: result.messageMatches.map((match) => ({
          messageId: match.messageId,
          snippet: match.snippet,
          ...(match.role ? { role: match.role } : {}),
          ...(match.createdAt ? { createdAt: match.createdAt } : {})
        }))
      }))
    }
  }

  return {
    'host.remote.listThreadSummaries': listThreadSummaries,
    'host.remote.getThreadSummary': getThreadSummary,
    'host.remote.getThreadVisibility': getThreadVisibility,
    'host.remote.loadThread': loadThread,
    'host.remote.loadThreadMeasured': loadThreadMeasured,
    'host.remote.listRecentWorkspaces': listRecentWorkspaces,
    'host.remote.listSelectableModels': listSelectableModels,
    'host.remote.listEssentials': listEssentials,
    'host.remote.getEssential': getEssential,
    'host.remote.getEssentialIcon': getEssentialIcon,
    'host.remote.getFile': getFile,
    'host.remote.getAppearance': getAppearance,
    'host.remote.getHostInfo': getHostInfo,
    'host.remote.listTasks': listTasks,
    'host.remote.getImage': getImage,
    'host.remote.search': search,
    'host.remote.getToolPreview': getToolPreview
  }
}

function projectEssential(
  essential: NonNullable<SettingsConfig['essentials']>[number],
  iconVersion?: string
): RemoteEssential {
  const workspaceName = workspaceNameOf(essential.workspacePath)
  return {
    id: essential.id,
    ...(essential.iconType === 'emoji' && essential.icon ? { icon: essential.icon } : {}),
    ...(essential.iconType === 'image' && essential.icon ? { hasImageIcon: true } : {}),
    ...(iconVersion ? { iconVersion } : {}),
    ...(essential.label ? { label: essential.label } : {}),
    ...(essential.workspacePath ? { workspacePath: essential.workspacePath } : {}),
    ...(workspaceName ? { workspaceName } : {}),
    privacyMode: Boolean(essential.privacyMode),
    ...(essential.modelOverride
      ? {
          modelOverride: {
            providerName: essential.modelOverride.providerName,
            model: essential.modelOverride.model
          }
        }
      : {}),
    order: essential.order
  }
}

export function appearanceOf(config: Pick<SettingsConfig, 'general'>): RemoteAppearance {
  return {
    themeId: config.general?.themeId ?? DEFAULT_THEME_ID,
    themeAppearance: config.general?.themeAppearance ?? DEFAULT_THEME_APPEARANCE
  }
}
