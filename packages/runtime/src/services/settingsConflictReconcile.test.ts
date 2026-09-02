import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  RememberedSettingsResolution,
  SettingsFieldResolutionMemory
} from '../storage/storage.ts'
import {
  decideSettingsConflict,
  partitionRememberedSettingsFields
} from './settingsConflictReconcile.ts'

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
): RememberedSettingsResolution => input

describe('partitionRememberedSettingsFields', () => {
  const memory = (
    path: string,
    localFingerprint: string,
    remoteFingerprint: string,
    choice: 'local' | 'remote' = 'local'
  ): SettingsFieldResolutionMemory => ({ path, localFingerprint, remoteFingerprint, choice })

  it('keeps previously resolved fields hidden when an unrelated field changes', () => {
    const result = partitionRememberedSettingsFields(
      [
        {
          path: 'chat.model',
          localValue: 'local-model',
          remoteValue: 'remote-model',
          localFingerprint: 'local-model-hash',
          remoteFingerprint: 'remote-model-hash'
        },
        {
          path: 'general.chatFontSize',
          localValue: '18',
          remoteValue: '20',
          localFingerprint: '18-hash',
          remoteFingerprint: '20-hash'
        }
      ],
      [memory('chat.model', 'local-model-hash', 'remote-model-hash')]
    )

    assert.deepEqual(result.rememberedSelections, { 'chat.model': 'local' })
    assert.deepEqual(
      result.unresolvedFields.map((field) => field.path),
      ['general.chatFontSize']
    )
  })

  it('prompts again only for a resolved field whose value changed', () => {
    const result = partitionRememberedSettingsFields(
      [
        {
          path: 'chat.model',
          localValue: 'new-local-model',
          remoteValue: 'remote-model',
          localFingerprint: 'new-local-model-hash',
          remoteFingerprint: 'remote-model-hash'
        }
      ],
      [memory('chat.model', 'old-local-model-hash', 'remote-model-hash')]
    )

    assert.deepEqual(result.rememberedSelections, {})
    assert.deepEqual(
      result.unresolvedFields.map((field) => field.path),
      ['chat.model']
    )
  })
})

describe('decideSettingsConflict', () => {
  it('prompts for a brand-new difference with no remembered choice', () => {
    assert.equal(decideSettingsConflict(conflict('a', 'b'), remembered()), 'prompt')
    assert.equal(decideSettingsConflict(conflict('a', 'b'), undefined), 'prompt')
  })

  it('drops a conflict whose sides are already identical', () => {
    assert.equal(decideSettingsConflict(conflict('same', 'same'), undefined), 'drop')
  })

  it('drops an exact recurring conflict the user kept local before', () => {
    assert.equal(
      decideSettingsConflict(conflict('a', 'b'), remembered({ exact: 'keep_local' })),
      'drop'
    )
  })

  it('prompts after a local edit instead of letting whole-config memory hide new fields', () => {
    assert.equal(decideSettingsConflict(conflict('a2', 'b'), remembered()), 'prompt')
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
      decideSettingsConflict(conflict('a', 'b', 'thread'), remembered({ exact: 'keep_local' })),
      'prompt'
    )
  })
})
