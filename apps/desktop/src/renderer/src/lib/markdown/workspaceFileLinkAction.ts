import type { InlineCodeFileLinkSnapshot } from './inlineCodeFileLinkSnapshot.ts'
import { WORKSPACE_FILE_REFERENCE_PROPERTY } from './workspaceFileLinkRehypePlugin.ts'

interface HastNodeLike {
  properties?: Record<string, unknown>
}

export interface ResolvedWorkspaceFileLink {
  reference: string
  path: string
}

export interface WorkspaceFileOperationScope {
  threadId?: string | null
  workspacePath?: string | null
}

export interface WorkspaceFileOperationInput {
  path: string
  threadId?: string
  workspacePath: string | null
  workspaceOnly: true
}

export function resolveWorkspaceFileLink(
  node: unknown,
  fileLinks?: InlineCodeFileLinkSnapshot
): ResolvedWorkspaceFileLink | null {
  if (!node || typeof node !== 'object' || !fileLinks) return null
  const reference = (node as HastNodeLike).properties?.[WORKSPACE_FILE_REFERENCE_PROPERTY]
  if (typeof reference !== 'string') return null
  const path = fileLinks.get(reference)
  return path ? { reference, path } : null
}

export function createWorkspaceFileOperationInput(
  link: ResolvedWorkspaceFileLink,
  scope: WorkspaceFileOperationScope
): WorkspaceFileOperationInput {
  return {
    path: link.path,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    workspacePath: scope.workspacePath ?? null,
    workspaceOnly: true
  }
}
