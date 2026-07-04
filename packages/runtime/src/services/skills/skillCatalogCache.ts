import type { SkillCatalogEntry } from '@yachiyo/shared/protocol'

/**
 * Skill discovery walks every skill root on disk, which is far too expensive to
 * repeat on every run leg (it sits on the blocking reply path). A short TTL keeps
 * turns fast while newly added or edited skill files still show up within seconds.
 */
export const SKILL_CATALOG_TTL_MS = 15_000

interface CacheSlot {
  loadedAt: number
  entries: SkillCatalogEntry[]
}

export function createCachedSkillCatalogLoader(input: {
  loadCatalog: (workspacePaths: string[]) => Promise<SkillCatalogEntry[]>
  ttlMs?: number
  now?: () => number
}): (workspacePaths: string[]) => Promise<SkillCatalogEntry[]> {
  const ttlMs = input.ttlMs ?? SKILL_CATALOG_TTL_MS
  const now = input.now ?? Date.now
  const cache = new Map<string, CacheSlot>()
  const inFlight = new Map<string, Promise<SkillCatalogEntry[]>>()

  return async (workspacePaths: string[]): Promise<SkillCatalogEntry[]> => {
    const key = [...workspacePaths].sort().join('\n')

    const cached = cache.get(key)
    if (cached && now() - cached.loadedAt < ttlMs) {
      return cached.entries
    }

    const pending = inFlight.get(key)
    if (pending) {
      return pending
    }

    const load = input
      .loadCatalog(workspacePaths)
      .then((entries) => {
        cache.set(key, { loadedAt: now(), entries })
        // Drop expired slots so long-lived servers with many thread workspaces
        // do not accumulate stale catalogs.
        for (const [slotKey, slot] of cache) {
          if (now() - slot.loadedAt >= ttlMs) {
            cache.delete(slotKey)
          }
        }
        return entries
      })
      .finally(() => {
        inFlight.delete(key)
      })

    inFlight.set(key, load)
    return load
  }
}
