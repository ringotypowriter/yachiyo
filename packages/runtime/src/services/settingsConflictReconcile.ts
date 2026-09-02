import type { SettingsFieldDifference } from '../settings/settingsFieldMerge.ts'
import type {
  RememberedSettingsResolution,
  SettingsFieldResolutionMemory
} from '../storage/storage.ts'

/**
 * What to do with a settings conflict the sync binary just recorded, without
 * bothering the user when their earlier decision still applies.
 *
 *  - `prompt`       — a genuinely new conflict (or one we can't safely auto-apply);
 *                     leave it for the user to resolve.
 *  - `drop`         — auto-handle and remove it because the two sides, or the exact
 *                     whole-config conflict and its remembered choice, still match.
 *  - `apply-remote` — re-apply the user's remembered "use synced version" choice,
 *                     then remove the conflict.
 */
export type SettingsConflictDecision = 'prompt' | 'drop' | 'apply-remote'

export function partitionRememberedSettingsFields(
  fields: SettingsFieldDifference[],
  remembered: SettingsFieldResolutionMemory[]
): {
  rememberedSelections: Record<string, 'local' | 'remote'>
  unresolvedFields: SettingsFieldDifference[]
} {
  const choices = new Map(
    remembered.map((item) => [
      `${item.path}\0${item.localFingerprint}\0${item.remoteFingerprint}`,
      item.choice
    ])
  )
  const rememberedSelections: Record<string, 'local' | 'remote'> = {}
  const unresolvedFields = fields.filter((field) => {
    const choice = choices.get(
      `${field.path}\0${field.localFingerprint}\0${field.remoteFingerprint}`
    )
    if (!choice) return true
    rememberedSelections[field.path] = choice
    return false
  })
  return { rememberedSelections, unresolvedFields }
}

/**
 * Decide a single settings conflict.
 *
 * Whole-config choices are replayed only for the exact `(localHash, remoteHash)` pair.
 * Once either side changes, field fingerprints decide which choices still apply so a
 * new field cannot be hidden by an older whole-config `keep_local` decision. `merge`
 * cannot be replayed from whole-config hashes and falls through to field memory.
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
  if (remembered.exact === 'keep_local') return 'drop'
  if (remembered.exact === 'use_remote') return 'apply-remote'
  // 'merge' or no matching memory — field-level reconciliation decides.
  return 'prompt'
}
