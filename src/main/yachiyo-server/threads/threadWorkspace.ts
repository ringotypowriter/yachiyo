import { access, cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

import { resolveThreadWorkspacePath, resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'

const DISPOSABLE_YACHIYO_DIRS = new Set(['tool-result', 'tool-output'])

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

async function hasAnyFiles(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      return true
    }
    if (entry.isDirectory()) {
      if (entry.name === '.yachiyo') {
        const yachiyoPath = join(dirPath, entry.name)
        const yachiyoEntries = await readdir(yachiyoPath, { withFileTypes: true })
        for (const yEntry of yachiyoEntries) {
          if (!yEntry.isDirectory()) {
            // Any file directly under .yachiyo/ is considered non-disposable
            return true
          }
          if (!DISPOSABLE_YACHIYO_DIRS.has(yEntry.name)) {
            const childHasFiles = await hasAnyFiles(join(yachiyoPath, yEntry.name))
            if (childHasFiles) {
              return true
            }
          }
        }
        continue
      }
      const childHasFiles = await hasAnyFiles(join(dirPath, entry.name))
      if (childHasFiles) {
        return true
      }
    }
  }
  return false
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

export async function deleteThreadWorkspace(threadId: string): Promise<void> {
  await rm(resolveThreadWorkspacePath(threadId), {
    force: true,
    recursive: true
  })
}

export async function pruneEmptyTemporaryWorkspaces(
  shouldPrune?: (name: string) => boolean | Promise<boolean>
): Promise<number> {
  return pruneEmptyWorkspaces(resolveYachiyoTempWorkspaceRoot(), shouldPrune)
}

export async function pruneEmptyWorkspaces(
  root: string,
  shouldPrune?: (name: string) => boolean | Promise<boolean>
): Promise<number> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 0
    }
    throw error
  }

  const dirs = entries.filter((e) => e.isDirectory())
  const dirsWithMtime: { name: string; mtime: number }[] = []

  for (const dir of dirs) {
    const s = await stat(join(root, dir.name))
    dirsWithMtime.push({ name: dir.name, mtime: s.mtimeMs })
  }

  dirsWithMtime.sort((a, b) => a.mtime - b.mtime)

  let pruned = 0
  for (const { name } of dirsWithMtime) {
    const dirPath = join(root, name)
    if (shouldPrune && !(await shouldPrune(name))) {
      continue
    }
    const anyFiles = await hasAnyFiles(dirPath)
    if (!anyFiles) {
      await rm(dirPath, { recursive: true, force: true })
      pruned++
    }
  }

  return pruned
}
