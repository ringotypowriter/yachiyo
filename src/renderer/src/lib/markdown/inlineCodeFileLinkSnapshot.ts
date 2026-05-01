import { useEffect, useMemo, useState } from 'react'

import {
  extractInlineCodeFileReferences,
  isAbsoluteInlineCodeFileReference
} from '../../../../shared/yachiyo/inlineCodeFileReferences.ts'

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
  workspacePath?: string | null
}): InlineCodeFileLinkSnapshot {
  const { enabled, markdownDocuments, workspacePath } = input
  const references = useMemo(
    () => (enabled ? extractUniqueInlineCodeFileReferences(markdownDocuments) : []),
    [enabled, markdownDocuments]
  )
  const hasResolvableReference = useMemo(
    () =>
      Boolean(workspacePath) ||
      references.some((reference) => isAbsoluteInlineCodeFileReference(reference)),
    [workspacePath, references]
  )
  const cacheKey = useMemo(() => {
    if (!hasResolvableReference || references.length === 0) {
      return ''
    }
    return JSON.stringify([workspacePath ?? null, references])
  }, [hasResolvableReference, workspacePath, references])
  const [resolvedSnapshot, setResolvedSnapshot] = useState<{
    cacheKey: string
    snapshot: InlineCodeFileLinkSnapshot
  }>({ cacheKey: '', snapshot: EMPTY_FILE_LINK_SNAPSHOT })

  useEffect(() => {
    console.log('[inline-code-file-links] snapshot input', {
      enabled,
      hasWorkspacePath: Boolean(workspacePath),
      documentCount: markdownDocuments.length,
      references
    })

    if (!hasResolvableReference || references.length === 0 || !cacheKey) {
      console.log('[inline-code-file-links] skipped resolve', {
        reason: references.length === 0 ? 'no-references' : 'no-resolvable-references'
      })
      return
    }

    const api = window.api?.yachiyo
    if (!api?.resolveFileReferences) {
      console.log('[inline-code-file-links] skipped resolve', {
        reason: 'missing-resolve-file-references-api'
      })
      return
    }

    let cancelled = false
    const snapshotPromise = resolveCachedSnapshot(cacheKey, workspacePath ?? null, references)

    void Promise.resolve(snapshotPromise)
      .then((nextSnapshot) => {
        if (!cancelled) {
          console.log('[inline-code-file-links] snapshot resolved', {
            referenceCount: references.length,
            linkedCount: nextSnapshot.size,
            linkedReferences: [...nextSnapshot.keys()]
          })
          setResolvedSnapshot({ cacheKey, snapshot: nextSnapshot })
        }
      })
      .catch((error) => {
        snapshotCache.delete(cacheKey)
        console.error('[inline-code-file-links] failed to resolve references', error)
        if (!cancelled) {
          setResolvedSnapshot({ cacheKey, snapshot: EMPTY_FILE_LINK_SNAPSHOT })
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    cacheKey,
    enabled,
    hasResolvableReference,
    markdownDocuments.length,
    references,
    workspacePath
  ])

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

function resolveCachedSnapshot(
  cacheKey: string,
  workspacePath: string | null,
  references: readonly string[]
): InlineCodeFileLinkSnapshot | Promise<InlineCodeFileLinkSnapshot> {
  const cached = snapshotCache.get(cacheKey)
  if (cached) {
    console.log('[inline-code-file-links] cache hit', { cacheKey })
    return cached
  }

  console.log('[inline-code-file-links] resolving via ipc', { workspacePath, references })
  const snapshotPromise = window.api.yachiyo
    .resolveFileReferences({
      workspacePath,
      references: [...references]
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
