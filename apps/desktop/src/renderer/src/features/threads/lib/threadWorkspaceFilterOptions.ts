import type { Thread } from '../../../app/types.ts'
import { isExternalThread } from './threadVisibility.ts'

export const TEMPORARY_WORKSPACE_FILTER = '\0yachiyo-temporary-workspace'

export interface WorkspaceFilterOption {
  path: string
  displayName: string
  count: number
}

export function resolveWorkspaceFilterOptions({
  savedPaths,
  threads,
  archivedThreads
}: {
  savedPaths: string[]
  threads: Thread[]
  archivedThreads: Thread[]
}): WorkspaceFilterOption[] {
  const localThreads = [...threads, ...archivedThreads].filter(
    (thread) => !thread.createdFromScheduleId && !isExternalThread(thread)
  )
  const localWorkspacePaths = new Set(
    localThreads
      .flatMap((thread) => (thread.workspacePath ? [thread.workspacePath.trim()] : []))
      .filter((path) => path.length > 0)
  )
  const countByPath = new Map<string, number>()
  for (const thread of localThreads) {
    const workspacePath = thread.workspacePath?.trim()
    if (workspacePath) {
      countByPath.set(workspacePath, (countByPath.get(workspacePath) ?? 0) + 1)
    }
  }
  const seen = new Set<string>()
  const paths: Array<{ path: string; count: number; savedIndex: number }> = []

  function addPath(path: string, savedIndex: number): void {
    const normalized = path.trim()
    if (!normalized || seen.has(normalized) || !localWorkspacePaths.has(normalized)) return
    seen.add(normalized)
    paths.push({
      path: normalized,
      count: countByPath.get(normalized)!,
      savedIndex
    })
  }

  for (const [index, path] of savedPaths.entries()) {
    addPath(path, index)
  }

  paths.sort((left, right) => right.count - left.count || left.savedIndex - right.savedIndex)

  const savedPathSet = new Set(paths.map((item) => item.path))
  const temporaryCount = localThreads.filter((thread) => {
    const workspacePath = thread.workspacePath?.trim()
    return !workspacePath || !savedPathSet.has(workspacePath)
  }).length

  const displayNames = paths.map((item) => resolveWorkspaceDisplayName(item.path))
  const countByName = new Map<string, number>()
  for (const name of displayNames) {
    countByName.set(name, (countByName.get(name) ?? 0) + 1)
  }

  const options = paths.map((item, index) => ({
    path: item.path,
    count: item.count,
    displayName:
      countByName.get(displayNames[index])! > 1
        ? item.path.replace(/\/+$/, '').split('/').slice(-2).join('/')
        : displayNames[index]
  }))

  return temporaryCount > 0
    ? [
        ...options,
        { path: TEMPORARY_WORKSPACE_FILTER, displayName: 'Temporary', count: temporaryCount }
      ]
    : options
}

export function resolveWorkspaceDisplayName(workspacePath: string): string {
  if (workspacePath === TEMPORARY_WORKSPACE_FILTER) return 'Temporary'
  const segments = workspacePath.replace(/\/+$/, '').split('/')
  return segments[segments.length - 1] || workspacePath
}
