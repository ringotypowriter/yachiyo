import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  ResolvedFileReference,
  ResolveFileReferencesInput
} from '../../../shared/yachiyo/protocol.ts'
import {
  isAllowedInlineCodeFileReference,
  stripInlineCodeFileLocationSuffix
} from '../../../shared/yachiyo/inlineCodeFileReferences.ts'

export async function resolveExistingFileReferences(
  input: ResolveFileReferencesInput
): Promise<ResolvedFileReference[]> {
  const workspacePath = input.workspacePath ? resolve(input.workspacePath) : null
  const resolved: ResolvedFileReference[] = []
  const seenReferences = new Set<string>()

  console.log('[inline-code-file-links] server resolve start', {
    workspacePath,
    referenceCount: input.references.length,
    references: input.references
  })

  for (const reference of input.references) {
    const trimmedReference = reference.trim()
    if (!trimmedReference || seenReferences.has(trimmedReference)) {
      continue
    }
    seenReferences.add(trimmedReference)

    const filePath = await resolveExistingFileReference(workspacePath, trimmedReference)
    if (filePath) {
      console.log('[inline-code-file-links] server resolved reference', {
        reference: trimmedReference,
        path: filePath
      })
      resolved.push({ reference: trimmedReference, path: filePath })
    } else {
      console.log('[inline-code-file-links] server missed reference', {
        reference: trimmedReference,
        candidates: toCandidatePaths(workspacePath, trimmedReference)
      })
    }
  }

  console.log('[inline-code-file-links] server resolve done', {
    resolvedCount: resolved.length,
    resolved
  })

  return resolved
}

async function resolveExistingFileReference(
  workspacePath: string | null,
  reference: string
): Promise<string | null> {
  const candidates = toCandidatePaths(workspacePath, reference)
  for (const candidate of candidates) {
    if (await isExistingFile(candidate)) {
      return candidate
    }
  }

  return null
}

function toCandidatePaths(workspacePath: string | null, reference: string): string[] {
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
    if (!candidates.includes(resolvedPath)) {
      candidates.push(resolvedPath)
    }
  }

  return candidates
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

async function isExistingFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
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
