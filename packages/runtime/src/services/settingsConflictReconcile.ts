import type { SyncConflictResolution } from '@yachiyo/shared/protocol'

/**
 * What to do with a settings conflict the sync binary just recorded, without
 * bothering the user when their earlier decision still applies.
 *
 *  - `prompt`       — a genuinely new conflict (or one we can't safely auto-apply);
 *                     leave it for the user to resolve.
 *  - `drop`         — auto-handle and remove it: either the two sides are already
 *                     identical, or the user's remembered keep-local choice is
 *                     already reflected in the current local settings.
 *  - `apply-remote` — re-apply the user's remembered "use synced version" choice,
 *                     then remove the conflict.
 */
export type SettingsConflictDecision = 'prompt' | 'drop' | 'apply-remote'

/**
 * Decide a single settings conflict.
 *
 * A conflict's `localHash` captures exactly what the local settings were when the
 * user made their choice, so when the same `(localHash, remoteHash)` pair shows up
 * again the earlier preference still holds and we needn't ask again. `keep_local`
 * already lives in the unchanged local settings (drop); `use_remote` just needs the
 * synced version re-applied. `merge` is the exception: a field-level merge can't be
 * faithfully replayed from hashes alone, so we re-prompt rather than silently drop
 * the remote fields the user previously chose. (With export-dedup a resolved
 * conflict rarely recurs, so this re-prompt is near-theoretical.)
 */
export function decideSettingsConflict(
  conflict: { entityType: string; localHash: string; remoteHash: string },
  remembered: SyncConflictResolution | undefined
): SettingsConflictDecision {
  // Only settings conflicts are auto-handled; anything else is left untouched.
  if (conflict.entityType !== 'settings') return 'prompt'
  // Both sides already agree — there is nothing to decide.
  if (conflict.localHash === conflict.remoteHash) return 'drop'
  if (remembered === 'keep_local') return 'drop'
  if (remembered === 'use_remote') return 'apply-remote'
  // 'merge' or no memory — the user decides.
  return 'prompt'
}
