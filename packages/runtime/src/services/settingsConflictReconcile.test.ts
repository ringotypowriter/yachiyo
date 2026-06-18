import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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

describe('decideSettingsConflict', () => {
  it('prompts for a brand-new difference with no remembered choice', () => {
    assert.equal(decideSettingsConflict(conflict('a', 'b'), undefined), 'prompt')
  })

  it('drops a conflict whose sides are already identical', () => {
    assert.equal(decideSettingsConflict(conflict('same', 'same'), undefined), 'drop')
  })

  it('drops a recurring conflict the user kept local before', () => {
    assert.equal(decideSettingsConflict(conflict('a', 'b'), 'keep_local'), 'drop')
  })

  it('re-prompts a remembered merge (field selections cannot be replayed from hashes)', () => {
    assert.equal(decideSettingsConflict(conflict('m', 'b'), 'merge'), 'prompt')
  })

  it('re-applies a remembered "use synced version" choice', () => {
    assert.equal(decideSettingsConflict(conflict('a', 'b'), 'use_remote'), 'apply-remote')
  })

  it('identical sides win even when a choice was remembered', () => {
    assert.equal(decideSettingsConflict(conflict('x', 'x'), 'use_remote'), 'drop')
  })

  it('leaves non-settings conflicts untouched', () => {
    assert.equal(decideSettingsConflict(conflict('a', 'b', 'thread'), 'keep_local'), 'prompt')
  })
})
