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
  RemoteWorkspace
} from '@yachiyo/shared/remote/projections'
import { buildMessageTreeMaps, collectMessagePathFromMaps } from '@yachiyo/shared/threadTree'

import type { YachiyoServer } from '../YachiyoServer.ts'
import { assertPageLimit } from '../../../storage/messagePageWindow.ts'
import { fitRemoteThreadBudget } from './remoteThreadBudget.ts'
import { resolveThreadWorkspacePath } from '../../../config/paths.ts'
import { readRemoteWorkspaceFile } from './remoteWorkspaceFile.ts'
import { readEssentialIcon } from './remoteEssentialIcon.ts'

const THREAD_LIST_DEFAULT = 100
const RECENT_WORKSPACE_LIMIT = 20
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

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

export interface RemoteHostOps {
  'host.remote.listThreadSummaries'(input: { cursor?: string; limit?: number }): ThreadListPage
  'host.remote.getThreadSummary'(input: { threadId: string }): RemoteThreadSummary | null
  'host.remote.loadThread'(input: {
    threadId: string
    limit?: number
    beforeMessageId?: string
  }): RemoteThreadDetail
  'host.remote.listRecentWorkspaces'(): { workspaces: RemoteWorkspace[] }
  'host.remote.listSelectableModels'(): Promise<{ models: RemoteSelectableModel[] }>
  'host.remote.listEssentials'(): Promise<{ essentials: RemoteEssential[] }>
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
}

/**
 * Read-only projections behind `host.remote.*`. They run in the runtime process so path
 * computation and truncation never happen on the main thread, and nothing here reads
 * provider credentials: settings are only consulted for model names, essentials, and theme.
 */
export function createRemoteHostOps(server: RemoteProjectionServer): RemoteHostOps {
  const storage = (): ReturnType<YachiyoServer['getStorage']> => server.getStorage()
  let syncDeviceIdPromise: Promise<string | undefined> | null = null

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

  function requireActiveThread(threadId: string): ThreadRecord {
    const thread = storage().getThread(threadId)
    if (!thread || thread.archivedAt) throw new RemoteNotFoundError('Thread not found.')
    return thread
  }

  function listThreadSummaries(input: { cursor?: string; limit?: number }): ThreadListPage {
    const { threads, latestRunsByThread } = storage().bootstrap()
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid thread list cursor.')
    const limit = input.limit ?? THREAD_LIST_DEFAULT
    const page = threads.slice(offset, offset + limit)
    const next = offset + page.length
    return {
      threads: page.map((thread) => summarize(thread, latestRunsByThread[thread.id])),
      ...(next < threads.length ? { nextCursor: String(next) } : {})
    }
  }

  function getThreadSummary(input: { threadId: string }): RemoteThreadSummary | null {
    const thread = storage().getThread(input.threadId)
    if (!thread || thread.archivedAt) return null
    return summarize(thread, latestRunOf(thread.id))
  }

  function loadThread(input: {
    threadId: string
    limit?: number
    beforeMessageId?: string
  }): RemoteThreadDetail {
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

    return fitRemoteThreadBudget({
      thread: projectThreadSummary(thread, {
        ...(latestRun ? { latestRun } : {}),
        needsAttention:
          (activeRun ? storage().hasThreadWaitingToolCall(thread.id) : false) || pendingPlan
      }),
      messages: projected,
      hasMoreBefore: start > 0,
      toolCalls: toolCalls.map(projectToolCall),
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
            const workspaceName = workspaceNameOf(essential.workspacePath)
            // Read content, not just the configured path: local files can change in place.
            // HTTP icons remain unversioned so network timeouts never block options metadata.
            // A broken image must not prevent loading the other new-thread options.
            const image =
              essential.iconType === 'image' &&
              essential.icon &&
              (essential.icon.startsWith('data:') ||
                essential.icon.startsWith('file:') ||
                isAbsolute(essential.icon))
                ? await readEssentialIcon(essential.icon).catch(() => undefined)
                : undefined
            return {
              id: essential.id,
              ...(essential.iconType === 'emoji' && essential.icon ? { icon: essential.icon } : {}),
              ...(essential.iconType === 'image' && essential.icon ? { hasImageIcon: true } : {}),
              ...(image ? { iconVersion: image.iconVersion } : {}),
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
          })
      )
    }
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
    return readEssentialIcon(essential.icon)
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
    'host.remote.loadThread': loadThread,
    'host.remote.listRecentWorkspaces': listRecentWorkspaces,
    'host.remote.listSelectableModels': listSelectableModels,
    'host.remote.listEssentials': listEssentials,
    'host.remote.getEssentialIcon': getEssentialIcon,
    'host.remote.getFile': getFile,
    'host.remote.getAppearance': getAppearance,
    'host.remote.getHostInfo': getHostInfo,
    'host.remote.listTasks': listTasks,
    'host.remote.getImage': getImage,
    'host.remote.search': search
  }
}

export function appearanceOf(config: Pick<SettingsConfig, 'general'>): RemoteAppearance {
  return {
    themeId: config.general?.themeId ?? DEFAULT_THEME_ID,
    themeAppearance: config.general?.themeAppearance ?? DEFAULT_THEME_APPEARANCE
  }
}
