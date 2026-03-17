import { access, cp, mkdir } from 'node:fs/promises'

import { resolveThreadWorkspacePath } from './paths.ts'

export async function ensureThreadWorkspace(threadId: string): Promise<string> {
  const workspacePath = resolveThreadWorkspacePath(threadId)
  await mkdir(workspacePath, { recursive: true })
  return workspacePath
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

export async function cloneThreadWorkspace(
  sourceThreadId: string,
  targetThreadId: string
): Promise<string> {
  const sourceWorkspacePath = resolveThreadWorkspacePath(sourceThreadId)
  const targetWorkspacePath = resolveThreadWorkspacePath(targetThreadId)

  if (!(await pathExists(sourceWorkspacePath))) {
    await mkdir(targetWorkspacePath, { recursive: true })
    return targetWorkspacePath
  }

  await cp(sourceWorkspacePath, targetWorkspacePath, {
    recursive: true,
    force: true
  })

  return targetWorkspacePath
}
