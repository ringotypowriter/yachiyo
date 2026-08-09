import assert from 'node:assert/strict'
import test from 'node:test'

import { selectNewCompatibleCoreSkillNames } from './coreSkillPlatform.ts'

const SKILLS = [
  { name: 'yachiyo-help' },
  { name: 'yachiyo-kagete', platforms: ['darwin'] as const },
  { name: 'windows-notes', platforms: ['win32'] as const }
]

test('Windows auto-enables only newly registered compatible core skills', () => {
  assert.deepEqual(selectNewCompatibleCoreSkillNames(SKILLS, [], 'win32'), [
    'yachiyo-help',
    'windows-notes'
  ])
  assert.deepEqual(selectNewCompatibleCoreSkillNames(SKILLS, ['yachiyo-help'], 'win32'), [
    'windows-notes'
  ])
})

test('macOS keeps its platform skills while missing metadata remains cross-platform', () => {
  assert.deepEqual(selectNewCompatibleCoreSkillNames(SKILLS, [], 'darwin'), [
    'yachiyo-help',
    'yachiyo-kagete'
  ])
})
