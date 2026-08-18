import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { ResolvedFileReference, ResolveFileReferencesInput } from '@yachiyo/shared/protocol'
import {
  isAllowedInlineCodeFileReference,
  stripInlineCodeFileLocationSuffix
} from '@yachiyo/shared/inlineCodeFileReferences'
import { resolveThreadWorkspacePath } from '../../config/paths.ts'

export async function resolveExistingFileReferences(
  input: ResolveFileReferencesInput
): Promise<ResolvedFileReference[]> {
  const workspacePath = resolveInputWorkspacePath(input)
  const realWorkspacePath = input.workspaceOnly
    ? await resolveExistingRealPath(workspacePath)
    : null
  if (input.workspaceOnly && !realWorkspacePath) {
    return []
  }

  const resolved: ResolvedFileReference[] = []
  const seenReferences = new Set<string>()

  for (const reference of input.references) {
    const trimmedReference = reference.trim()
    if (!trimmedReference || seenReferences.has(trimmedReference)) {
      continue
    }
    seenReferences.add(trimmedReference)

    const filePath = await resolveExistingFileReference({
      workspacePath,
      realWorkspacePath,
      workspaceOnly: input.workspaceOnly === true,
      reference: trimmedReference
    })
    if (filePath) {
      resolved.push({ reference: trimmedReference, path: filePath })
    }
  }

  return resolved
}

function resolveInputWorkspacePath(input: ResolveFileReferencesInput): string | null {
  const explicitWorkspacePath = input.workspacePath?.trim()
  if (explicitWorkspacePath) {
    return resolve(explicitWorkspacePath)
  }

  const threadId = input.threadId?.trim()
  return threadId ? resolve(resolveThreadWorkspacePath(threadId)) : null
}

async function resolveExistingFileReference(input: {
  workspacePath: string | null
  realWorkspacePath: string | null
  workspaceOnly: boolean
  reference: string
}): Promise<string | null> {
  const candidates = toCandidatePaths(
    input.workspacePath,
    input.realWorkspacePath,
    input.reference,
    input.workspaceOnly
  )
  const allowDirectory = isExplicitFolderReference(input.reference)
  for (const candidate of candidates) {
    if (!(await isExistingFileReferenceTarget(candidate, allowDirectory))) continue
    if (!input.workspaceOnly) {
      return candidate
    }

    const realCandidatePath = await resolveExistingRealPath(candidate)
    if (
      input.realWorkspacePath &&
      realCandidatePath &&
      isPathInside(input.realWorkspacePath, realCandidatePath)
    ) {
      return realCandidatePath
    }
  }

  return null
}

function toCandidatePaths(
  workspacePath: string | null,
  realWorkspacePath: string | null,
  reference: string,
  workspaceOnly: boolean
): string[] {
  if (!isAllowedInlineCodeFileReference(reference)) {
    return []
  }

  const pathParts = [reference]
  const withoutLocation = stripInlineCodeFileLocationSuffix(reference)
  if (withoutLocation !== reference) {
    pathParts.push(withoutLocation)
  }

  const candidates: string[] = []
  for (const pathPart of pathParts) {
    const isAbsolutePath = isAbsolute(pathPart)
    const resolvedPath = isAbsolutePath
      ? resolve(pathPart)
      : resolveRelativeCandidatePath(workspacePath, pathPart)
    if (!resolvedPath) continue
    if (
      workspaceOnly &&
      (!workspacePath ||
        (!isPathInside(workspacePath, resolvedPath) &&
          (!realWorkspacePath || !isPathInside(realWorkspacePath, resolvedPath))))
    ) {
      continue
    }
    if (!candidates.includes(resolvedPath)) {
      candidates.push(resolvedPath)
    }
  }

  return candidates
}

async function resolveExistingRealPath(path: string | null): Promise<string | null> {
  if (!path) return null
  try {
    return await realpath(path)
  } catch (error) {
    if (isExpectedStatMiss(error)) {
      return null
    }
    throw error
  }
}

function resolveRelativeCandidatePath(
  workspacePath: string | null,
  pathPart: string
): string | null {
  if (!workspacePath) return null
  const resolvedPath = resolve(workspacePath, pathPart)
  if (!isPathInside(workspacePath, resolvedPath)) return null
  return resolvedPath
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const pathFromBase = relative(basePath, targetPath)
  return pathFromBase === '' || (!pathFromBase.startsWith('..') && !isAbsolute(pathFromBase))
}

function isExplicitFolderReference(reference: string): boolean {
  const pathPart = stripInlineCodeFileLocationSuffix(reference.trim())
  return pathPart.endsWith('/') || pathPart.endsWith('\\')
}

async function isExistingFileReferenceTarget(
  path: string,
  allowDirectory: boolean
): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile() || (allowDirectory && stats.isDirectory())
  } catch (error) {
    if (isExpectedStatMiss(error)) {
      return false
    }
    throw error
  }
}

function isExpectedStatMiss(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'EACCES' ||
      error.code === 'EPERM')
  )
}
