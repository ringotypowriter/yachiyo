import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ThreadRecord } from '../../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../../config/paths.ts'
import { pruneEmptyTemporaryWorkspaces as defaultPruneEmptyTemporaryWorkspaces } from '../../threads/threadWorkspace.ts'

export async function openThreadWorkspacePath(input: {
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  thread: ThreadRecord
}): Promise<string> {
  const workspacePath = input.thread.workspacePath?.trim()
  if (workspacePath) {
    const resolvedWorkspacePath = resolve(workspacePath)
    await mkdir(resolvedWorkspacePath, { recursive: true })
    return resolvedWorkspacePath
  }

  return input.ensureThreadWorkspace(input.thread.id)
}

export async function pruneUnusedTemporaryWorkspaces(input: {
  archivedThreads: ThreadRecord[]
  threads: ThreadRecord[]
}): Promise<number> {
  const assignedPaths = new Set<string>()
  for (const thread of [...input.threads, ...input.archivedThreads]) {
    if (thread.workspacePath) {
      assignedPaths.add(thread.workspacePath)
    }
  }
  return defaultPruneEmptyTemporaryWorkspaces((name) => {
    const dirPath = join(resolveYachiyoTempWorkspaceRoot(), name)
    return !assignedPaths.has(dirPath)
  })
}
