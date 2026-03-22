import electron from 'electron'

import { ensureThreadWorkspace } from './yachiyo-server/threads/threadWorkspace.ts'

export interface OpenThreadWorkspaceDependencies {
  ensureWorkspace?: (threadId: string, workspacePath?: string) => Promise<string>
  openPath?: (path: string) => Promise<string>
}

export async function openThreadWorkspace(
  threadId: string,
  workspacePath?: string,
  dependencies: OpenThreadWorkspaceDependencies = {}
): Promise<void> {
  const ensureWorkspace =
    dependencies.ensureWorkspace ??
    ((currentThreadId: string, currentWorkspacePath?: string) =>
      currentWorkspacePath
        ? Promise.resolve(currentWorkspacePath)
        : ensureThreadWorkspace(currentThreadId))
  const fallbackOpenPath = electron.shell?.openPath?.bind(electron.shell)
  if (!dependencies.openPath && !fallbackOpenPath) {
    throw new Error('Electron shell.openPath is unavailable.')
  }

  const openPath = dependencies.openPath ?? fallbackOpenPath!
  const resolvedWorkspacePath = await ensureWorkspace(threadId, workspacePath)
  const errorMessage = await openPath(resolvedWorkspacePath)

  if (errorMessage) {
    throw new Error(errorMessage)
  }
}
