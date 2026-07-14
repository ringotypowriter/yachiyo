import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RememberedSettingsResolution } from '../storage/storage.ts'
import { decideSettingsConflict } from './settingsConflictReconcile.ts'

const conflict = (
  localHash: string,
  remoteHash: string,
  entityType = 'settings'
): { entityType: string; localHash: string; remoteHash: string } => ({
  entityType,
  localHash,
  remoteHash
})

const remembered = (
  input: Partial<RememberedSettingsResolution> = {}
): RememberedSettingsResolution => ({
  keptLocalForRemote: false,
  ...input
})

describe('decideSettingsConflict', () => {
  it('prompts for a brand-new difference with no remembered choice', () => {
    assert.equal(decideSettingsConflict(conflict('a', 'b'), remembered()), 'prompt')
    assert.equal(decideSettingsConflict(conflict('a', 'b'), undefined), 'prompt')
  })

  it('drops a conflict whose sides are already identical', () => {
    assert.equal(decideSettingsConflict(conflict('same', 'same'), undefined), 'drop')
  })

  it('drops a recurring conflict the user kept local before', () => {
    assert.equal(
      decideSettingsConflict(conflict('a', 'b'), remembered({ keptLocalForRemote: true })),
      'drop'
    )
  })

  it('keeps a remembered keep-local decision after an unrelated local edit', () => {
    // The local settings changed (localHash 'a' -> 'a2') but the rejected remote
    // version 'b' is unchanged, so the earlier "keep mine" still holds and we must
    // not re-nag. This is the core recurrence bug: the memory keys on remoteHash,
    // not on the whole-blob localHash.
    assert.equal(
      decideSettingsConflict(conflict('a2', 'b'), remembered({ keptLocalForRemote: true })),
      'drop'
    )
  })

  it('re-applies a remembered "use synced version" choice for the same local state', () => {
    assert.equal(
      decideSettingsConflict(conflict('a', 'b'), remembered({ exact: 'use_remote' })),
      'apply-remote'
    )
  })

  it('does not re-apply "use synced version" once local has moved on', () => {
    // Only the exact (localHash, remoteHash) pair re-applies remote; a different
    // localHash means the user edited after adopting it, so replaying remote would
    // clobber those edits. Re-prompt instead.
    assert.equal(
      decideSettingsConflict(conflict('a2', 'b'), remembered({ exact: undefined })),
      'prompt'
    )
  })

  it('re-prompts a remembered merge (field selections cannot be replayed from hashes)', () => {
    assert.equal(
      decideSettingsConflict(conflict('m', 'b'), remembered({ exact: 'merge' })),
      'prompt'
    )
  })

  it('identical sides win even when a choice was remembered', () => {
    assert.equal(
      decideSettingsConflict(conflict('x', 'x'), remembered({ exact: 'use_remote' })),
      'drop'
    )
  })

  it('leaves non-settings conflicts untouched', () => {
    assert.equal(
      decideSettingsConflict(
        conflict('a', 'b', 'thread'),
        remembered({ keptLocalForRemote: true })
      ),
      'prompt'
    )
  })
})
