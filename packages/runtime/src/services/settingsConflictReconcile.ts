import type { SyncConflictResolution } from '@yachiyo/shared/protocol'

/**
 * What to do with a settings conflict the sync binary just recorded, without
 * bothering the user when their earlier decision still applies.
 *
 *  - `prompt`       — a genuinely new conflict; leave it for the user to resolve.
 *  - `drop`         — auto-handle and remove it: either the two sides are already
 *                     identical, or the user's prior choice (keep-local / merge)
 *                     is already reflected in the current local settings.
 *  - `apply-remote` — re-apply the user's remembered "use synced version" choice,
 *                     then remove the conflict.
 */
export type SettingsConflictDecision = 'prompt' | 'drop' | 'apply-remote'

/**
 * Decide a single settings conflict.
 *
 * A conflict's `localHash` captures exactly what the local settings were when the
 * user made their choice. So when the same `(localHash, remoteHash)` pair shows
 * up again, the local content is unchanged and the earlier preference still holds
 * — there's no need to ask again. `use_remote` is the only remembered choice that
 * still needs an action (overwrite local with the synced version); `keep_local`
 * and `merge` already live in the unchanged local settings.
 */
export function decideSettingsConflict(
  conflict: { entityType: string; localHash: string; remoteHash: string },
  remembered: SyncConflictResolution | undefined
): SettingsConflictDecision {
  // Only settings conflicts are auto-handled; anything else is left untouched.
  if (conflict.entityType !== 'settings') return 'prompt'
  // Both sides already agree — there is nothing to decide.
  if (conflict.localHash === conflict.remoteHash) return 'drop'
  // First time we've seen this exact difference — the user must decide.
  if (remembered === undefined) return 'prompt'
  if (remembered === 'use_remote') return 'apply-remote'
  return 'drop'
}
