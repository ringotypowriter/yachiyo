import electron from 'electron'

import { ensureThreadWorkspace } from './yachiyo-server/threads/threadWorkspace.ts'

const { shell } = electron

export interface OpenThreadWorkspaceDependencies {
  ensureWorkspace?: (threadId: string) => Promise<string>
  openPath?: (path: string) => Promise<string>
}

export async function openThreadWorkspace(
  threadId: string,
  dependencies: OpenThreadWorkspaceDependencies = {}
): Promise<void> {
  const ensureWorkspace = dependencies.ensureWorkspace ?? ensureThreadWorkspace
  const openPath = dependencies.openPath ?? shell.openPath
  const workspacePath = await ensureWorkspace(threadId)
  const errorMessage = await openPath(workspacePath)

  if (errorMessage) {
    throw new Error(errorMessage)
  }
}
