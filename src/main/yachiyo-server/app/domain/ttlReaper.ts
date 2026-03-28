/**
 * TTL-based file reaper for temporary channel resources.
 *
 * Maintains a JSON manifest mapping absolute file/directory paths to their
 * creation time and TTL.  A periodic sweep deletes expired entries and
 * updates the manifest.
 *
 * Design goals:
 *   - Zero dependencies beyond node:fs and node:path
 *   - Graceful on corrupt/missing manifest (resets to empty)
 *   - Safe concurrent register + sweep (single-threaded Node event loop)
 */

import { readFile, rm, writeFile } from 'node:fs/promises'

export interface TtlEntry {
  createdAt: string // ISO-8601
  ttlMs: number
}

export type TtlManifest = Record<string, TtlEntry>

export interface TtlReaper {
  /** Register a path for future cleanup. */
  register(absolutePath: string, ttlMs: number): void
  /** Run a single sweep, deleting expired paths. */
  sweep(): Promise<{ deleted: string[] }>
  /** Start periodic sweeps (sweep immediately + setInterval). */
  start(): void
  /** Stop periodic sweeps. */
  stop(): void
}

export interface TtlReaperOptions {
  /** Path to the manifest JSON file. */
  manifestPath: string
  /** Sweep interval in milliseconds. @default 3_600_000 (1 hour) */
  intervalMs?: number
  /** Clock override for testing. */
  now?: () => Date
}

async function readManifest(path: string): Promise<TtlManifest> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as TtlManifest
    }
    return {}
  } catch {
    return {}
  }
}

async function writeManifest(path: string, manifest: TtlManifest): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8')
}

export function createTtlReaper(options: TtlReaperOptions): TtlReaper {
  const { manifestPath, intervalMs = 3_600_000, now = () => new Date() } = options

  /** In-memory buffer of entries registered since last flush. */
  let pendingRegistrations: TtlManifest = {}
  let timer: ReturnType<typeof setInterval> | null = null

  function register(absolutePath: string, ttlMs: number): void {
    pendingRegistrations[absolutePath] = {
      createdAt: now().toISOString(),
      ttlMs
    }
    // Flush to disk asynchronously — fire and forget.
    void flushRegistrations()
  }

  async function flushRegistrations(): Promise<void> {
    if (Object.keys(pendingRegistrations).length === 0) return

    const batch = pendingRegistrations
    pendingRegistrations = {}

    try {
      const manifest = await readManifest(manifestPath)
      Object.assign(manifest, batch)
      await writeManifest(manifestPath, manifest)
    } catch (err) {
      console.warn('[ttlReaper] failed to flush registrations:', err)
      // Re-queue so they aren't lost.
      pendingRegistrations = { ...batch, ...pendingRegistrations }
    }
  }

  async function sweep(): Promise<{ deleted: string[] }> {
    // Flush any pending registrations first so they're visible.
    await flushRegistrations()

    const manifest = await readManifest(manifestPath)
    const deleted: string[] = []
    const nowMs = now().getTime()

    for (const [path, entry] of Object.entries(manifest)) {
      const expiresAt = Date.parse(entry.createdAt) + entry.ttlMs
      if (expiresAt > nowMs) continue

      try {
        await rm(path, { recursive: true, force: true })
        deleted.push(path)
      } catch (err) {
        console.warn(`[ttlReaper] failed to delete ${path}:`, err)
        // Keep in manifest so we retry next sweep.
        continue
      }
      delete manifest[path]
    }

    await writeManifest(manifestPath, manifest)

    if (deleted.length > 0) {
      console.log(`[ttlReaper] swept ${deleted.length} expired path(s)`)
    }

    return { deleted }
  }

  function start(): void {
    if (timer) return
    void sweep()
    timer = setInterval(() => void sweep(), intervalMs)
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { register, sweep, start, stop }
}
