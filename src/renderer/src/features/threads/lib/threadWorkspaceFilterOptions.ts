import type { Thread } from '../../../app/types.ts'
import { isExternalThread } from './threadVisibility.ts'

export const TEMPORARY_WORKSPACE_FILTER = '\0yachiyo-temporary-workspace'

export interface WorkspaceFilterOption {
  path: string
  displayName: string
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
  const seen = new Set<string>()
  const paths: string[] = []

  function addPath(path: string): void {
    const normalized = path.trim()
    if (!normalized || seen.has(normalized) || !localWorkspacePaths.has(normalized)) return
    seen.add(normalized)
    paths.push(normalized)
  }

  for (const path of savedPaths) {
    addPath(path)
  }

  const savedPathSet = new Set(paths)
  const hasTemporaryThreads = localThreads.some((thread) => {
    const workspacePath = thread.workspacePath?.trim()
    return !workspacePath || !savedPathSet.has(workspacePath)
  })

  const displayNames = paths.map(resolveWorkspaceDisplayName)
  const countByName = new Map<string, number>()
  for (const name of displayNames) {
    countByName.set(name, (countByName.get(name) ?? 0) + 1)
  }

  const options = paths.map((path, index) => ({
    path,
    displayName:
      countByName.get(displayNames[index])! > 1
        ? path.replace(/\/+$/, '').split('/').slice(-2).join('/')
        : displayNames[index]
  }))

  return hasTemporaryThreads
    ? [...options, { path: TEMPORARY_WORKSPACE_FILTER, displayName: 'Temporary' }]
    : options
}

export function resolveWorkspaceDisplayName(workspacePath: string): string {
  if (workspacePath === TEMPORARY_WORKSPACE_FILTER) return 'Temporary'
  const segments = workspacePath.replace(/\/+$/, '').split('/')
  return segments[segments.length - 1] || workspacePath
}
