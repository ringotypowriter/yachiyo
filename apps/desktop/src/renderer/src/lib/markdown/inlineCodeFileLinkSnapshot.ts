import { useEffect, useMemo, useState } from 'react'

import {
  extractInlineCodeFileReferences,
  isAbsoluteInlineCodeFileReference
} from '@yachiyo/shared/inlineCodeFileReferences'
import { extractMarkdownFileReferences } from './markdownFileReferences'

const MAX_MARKDOWN_FILE_REFERENCES_PER_REQUEST = 64

export type InlineCodeFileLinkSnapshot = ReadonlyMap<string, string>

const EMPTY_FILE_LINK_SNAPSHOT: InlineCodeFileLinkSnapshot = new Map()
const MAX_SNAPSHOT_CACHE_ENTRIES = 100

const snapshotCache = new Map<
  string,
  InlineCodeFileLinkSnapshot | Promise<InlineCodeFileLinkSnapshot>
>()

export function useInlineCodeFileLinkSnapshot(input: {
  enabled: boolean
  markdownDocuments: readonly string[]
  threadId?: string | null
  workspacePath?: string | null
}): InlineCodeFileLinkSnapshot {
  const { enabled, markdownDocuments, threadId, workspacePath } = input
  const references = useMemo(
    () => (enabled ? extractUniqueInlineCodeFileReferences(markdownDocuments) : []),
    [enabled, markdownDocuments]
  )
  const hasResolvableReference = useMemo(
    () =>
      Boolean(workspacePath || threadId) ||
      references.some((reference) => isAbsoluteInlineCodeFileReference(reference)),
    [workspacePath, threadId, references]
  )

  return useResolvedFileLinkSnapshot({
    cacheScope: 'inline-code',
    hasResolvableReference,
    references,
    threadId,
    workspaceOnly: false,
    workspacePath
  })
}

export function useWorkspaceFileLinkSnapshot(input: {
  enabled: boolean
  markdownDocuments: readonly string[]
  threadId?: string | null
  workspacePath?: string | null
}): InlineCodeFileLinkSnapshot {
  const { enabled, markdownDocuments, threadId, workspacePath } = input
  const references = useMemo(
    () => (enabled ? extractUniqueMarkdownFileReferences(markdownDocuments) : []),
    [enabled, markdownDocuments]
  )

  return useResolvedFileLinkSnapshot({
    cacheScope: 'workspace-markdown',
    hasResolvableReference: Boolean(workspacePath || threadId),
    references,
    threadId,
    workspaceOnly: true,
    workspacePath
  })
}

function useResolvedFileLinkSnapshot(input: {
  cacheScope: string
  hasResolvableReference: boolean
  references: readonly string[]
  threadId?: string | null
  workspaceOnly: boolean
  workspacePath?: string | null
}): InlineCodeFileLinkSnapshot {
  const { cacheScope, hasResolvableReference, references, threadId, workspaceOnly, workspacePath } =
    input
  const cacheKey = useMemo(() => {
    if (!hasResolvableReference || references.length === 0) {
      return ''
    }
    return JSON.stringify([
      cacheScope,
      threadId ?? null,
      workspacePath ?? null,
      workspaceOnly,
      references
    ])
  }, [cacheScope, hasResolvableReference, references, threadId, workspaceOnly, workspacePath])
  const [resolvedSnapshot, setResolvedSnapshot] = useState<{
    cacheKey: string
    snapshot: InlineCodeFileLinkSnapshot
  }>({ cacheKey: '', snapshot: EMPTY_FILE_LINK_SNAPSHOT })

  useEffect(() => {
    if (!hasResolvableReference || references.length === 0 || !cacheKey) {
      return
    }

    const api = window.api?.yachiyo
    if (!api?.resolveFileReferences) {
      return
    }

    let cancelled = false
    const snapshotPromise = resolveCachedSnapshot(cacheKey, {
      threadId: threadId ?? undefined,
      workspacePath: workspacePath ?? null,
      workspaceOnly,
      references
    })

    void Promise.resolve(snapshotPromise)
      .then((nextSnapshot) => {
        if (!cancelled) {
          // Keep the previous state object when nothing changed so a resolve
          // from cache does not queue a redundant render.
          setResolvedSnapshot((prev) =>
            prev.cacheKey === cacheKey && prev.snapshot === nextSnapshot
              ? prev
              : { cacheKey, snapshot: nextSnapshot }
          )
        }
      })
      .catch(() => {
        snapshotCache.delete(cacheKey)
        if (!cancelled) {
          setResolvedSnapshot({ cacheKey, snapshot: EMPTY_FILE_LINK_SNAPSHOT })
        }
      })

    return () => {
      cancelled = true
    }
  }, [cacheKey, hasResolvableReference, references, threadId, workspaceOnly, workspacePath])

  if (!cacheKey || resolvedSnapshot.cacheKey !== cacheKey) {
    return EMPTY_FILE_LINK_SNAPSHOT
  }

  return resolvedSnapshot.snapshot
}

function extractUniqueInlineCodeFileReferences(markdownDocuments: readonly string[]): string[] {
  const references: string[] = []
  const seen = new Set<string>()

  for (const document of markdownDocuments) {
    for (const reference of extractInlineCodeFileReferences(document)) {
      if (seen.has(reference)) {
        continue
      }
      seen.add(reference)
      references.push(reference)
    }
  }

  return references
}

/**
 * The cap belongs to the resolver request, not to one document.
 *
 * Each link contributes up to two candidates, and a timeline holds many
 * messages, so a per-document cap bounds nothing about what is actually sent.
 * The remaining budget is handed down so a later document takes only the slots
 * that are left — and takes them in candidate order, keeping the decoded
 * reading over its own literal fallback.
 */
export function extractUniqueMarkdownFileReferences(
  markdownDocuments: readonly string[],
  maxReferences = MAX_MARKDOWN_FILE_REFERENCES_PER_REQUEST
): string[] {
  const references: string[] = []
  const seen = new Set<string>()

  for (const document of markdownDocuments) {
    const remaining = maxReferences - references.length
    // Correctness comes from passing the remaining budget below, which already
    // yields nothing at zero. This exit only avoids parsing every remaining
    // document in a long timeline once the budget is spent.
    if (remaining <= 0) break
    for (const reference of extractMarkdownFileReferences(document, remaining)) {
      if (seen.has(reference)) continue
      seen.add(reference)
      references.push(reference)
    }
  }

  return references
}

function resolveCachedSnapshot(
  cacheKey: string,
  input: {
    threadId?: string
    workspacePath: string | null
    workspaceOnly: boolean
    references: readonly string[]
  }
): InlineCodeFileLinkSnapshot | Promise<InlineCodeFileLinkSnapshot> {
  const cached = snapshotCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const snapshotPromise = window.api.yachiyo
    .resolveFileReferences({
      ...(input.threadId ? { threadId: input.threadId } : {}),
      workspacePath: input.workspacePath,
      workspaceOnly: input.workspaceOnly,
      references: [...input.references]
    })
    .then((resolved) => {
      const snapshot =
        resolved.length === 0
          ? EMPTY_FILE_LINK_SNAPSHOT
          : new Map(resolved.map((entry) => [entry.reference, entry.path]))
      snapshotCache.set(cacheKey, snapshot)
      return snapshot
    })

  snapshotCache.set(cacheKey, snapshotPromise)
  pruneSnapshotCache()
  return snapshotPromise
}

function pruneSnapshotCache(): void {
  while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
    const oldestKey = snapshotCache.keys().next().value
    if (!oldestKey) {
      return
    }
    snapshotCache.delete(oldestKey)
  }
}
