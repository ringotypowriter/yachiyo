import type { SidebarFilter } from '../../../app/store/useAppStore.ts'
import type { FolderRecord, RunStatus, Thread } from '../../../app/types.ts'
import { TEMPORARY_WORKSPACE_FILTER } from './threadWorkspaceFilterOptions.ts'
import { isExternalThread } from './threadVisibility.ts'

export interface ResolveVisibleSidebarThreadsInput {
  threads: Thread[]
  folders: FolderRecord[]
  archivedThreads: Thread[]
  externalThreads: Thread[]
  showExternalThreads: boolean
  savedWorkspacePaths?: string[]
  sidebarFilter: SidebarFilter
  threadListMode: 'active' | 'archived'
  runStatusesByThread: Record<string, RunStatus>
  backgroundTaskRunningThreadIds?: ReadonlySet<string>
  justDoneRunIdsByThread: Record<string, string>
}

export function resolveBackgroundTaskHydrationThreadIds({
  threads,
  archivedThreads,
  externalThreads
}: Pick<
  ResolveVisibleSidebarThreadsInput,
  'threads' | 'archivedThreads' | 'externalThreads'
>): string[] {
  const threadIds = new Set<string>()
  for (const thread of threads) threadIds.add(thread.id)
  for (const thread of archivedThreads) threadIds.add(thread.id)
  for (const thread of externalThreads) threadIds.add(thread.id)
  return [...threadIds]
}

export function resolveVisibleSidebarThreads({
  threads,
  folders,
  archivedThreads,
  externalThreads,
  showExternalThreads,
  savedWorkspacePaths = [],
  sidebarFilter,
  threadListMode,
  runStatusesByThread,
  backgroundTaskRunningThreadIds,
  justDoneRunIdsByThread
}: ResolveVisibleSidebarThreadsInput): Thread[] {
  let filtered = resolveThreadPool({
    threads,
    archivedThreads,
    externalThreads,
    showExternalThreads,
    threadListMode
  })

  if (sidebarFilter.colorTags.size > 0) {
    const folderColorById = new Map(folders.map((folder) => [folder.id, folder.colorTag]))
    filtered = filtered.filter((thread) => {
      if (thread.colorTag != null && sidebarFilter.colorTags.has(thread.colorTag)) return true
      const folderColor = thread.folderId ? folderColorById.get(thread.folderId) : null
      return folderColor != null && sidebarFilter.colorTags.has(folderColor)
    })
  }
  if (sidebarFilter.workspacePaths.size > 0) {
    const savedPathSet = new Set(
      savedWorkspacePaths.map((path) => path.trim()).filter((path) => path.length > 0)
    )
    const selectedSavedPaths = new Set(
      [...sidebarFilter.workspacePaths].filter((path) => path !== TEMPORARY_WORKSPACE_FILTER)
    )
    const includeTemporary = sidebarFilter.workspacePaths.has(TEMPORARY_WORKSPACE_FILTER)
    filtered = filtered.filter((thread) => {
      const workspacePath = thread.workspacePath?.trim()
      if (workspacePath && selectedSavedPaths.has(workspacePath)) return true

      return (
        includeTemporary &&
        !thread.createdFromScheduleId &&
        !isExternalThread(thread) &&
        (!workspacePath || !savedPathSet.has(workspacePath))
      )
    })
  }
  if (sidebarFilter.running) {
    filtered = filtered.filter((thread) =>
      isThreadRunning(thread.id, runStatusesByThread, backgroundTaskRunningThreadIds)
    )
  }
  if (sidebarFilter.justDone) {
    filtered = filtered.filter((thread) => Boolean(justDoneRunIdsByThread[thread.id]))
  }
  if (sidebarFilter.folderOnly) {
    filtered = filtered.filter((thread) => Boolean(thread.folderId))
  }

  return filtered.filter((thread) => {
    const isRunning = isThreadRunning(
      thread.id,
      runStatusesByThread,
      backgroundTaskRunningThreadIds
    )
    if (isRunning && thread.createdFromScheduleId) return false
    return thread.title !== 'New Chat' || thread.preview || thread.headMessageId || isRunning
  })
}

function isThreadRunning(
  threadId: string,
  runStatusesByThread: Record<string, RunStatus>,
  backgroundTaskRunningThreadIds: ReadonlySet<string> | undefined
): boolean {
  return (
    runStatusesByThread[threadId] === 'running' ||
    backgroundTaskRunningThreadIds?.has(threadId) === true
  )
}

function resolveThreadPool({
  threads,
  archivedThreads,
  externalThreads,
  showExternalThreads,
  threadListMode
}: Pick<
  ResolveVisibleSidebarThreadsInput,
  'threads' | 'archivedThreads' | 'externalThreads' | 'showExternalThreads' | 'threadListMode'
>): Thread[] {
  if (threadListMode === 'archived') return archivedThreads
  if (!showExternalThreads) return threads

  return [...threads, ...externalThreads].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )
}
