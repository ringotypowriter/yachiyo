import type { RememberedSettingsResolution } from '../storage/storage.ts'

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
 * The `remoteHash` identifies the exact synced settings the user reacted to, so it,
 * not the whole-blob `localHash`, anchors the memory. A `keep_local` ("keep mine")
 * against a given remote still holds even after the user later edits an unrelated
 * local setting — the rejected remote hasn't changed — so we key it on `remoteHash`
 * alone (`keptLocalForRemote`) and drop without re-nagging.
 *
 * `use_remote` is stricter: it re-applies the synced version, so we only replay it
 * for the exact `(localHash, remoteHash)` pair. A different `localHash` means the
 * user edited after adopting it, and blindly re-applying remote would clobber those
 * edits — re-prompt instead. `merge` can't be faithfully replayed from hashes, so it
 * always re-prompts.
 */
export function decideSettingsConflict(
  conflict: { entityType: string; localHash: string; remoteHash: string },
  remembered: RememberedSettingsResolution | undefined
): SettingsConflictDecision {
  // Only settings conflicts are auto-handled; anything else is left untouched.
  if (conflict.entityType !== 'settings') return 'prompt'
  // Both sides already agree — there is nothing to decide.
  if (conflict.localHash === conflict.remoteHash) return 'drop'
  if (!remembered) return 'prompt'
  // A prior "keep mine" against this exact remote version survives unrelated local edits.
  if (remembered.keptLocalForRemote) return 'drop'
  // "Use synced version" only replays for the same local state (see doc comment).
  if (remembered.exact === 'use_remote') return 'apply-remote'
  // 'merge' or no matching memory — the user decides.
  return 'prompt'
}
