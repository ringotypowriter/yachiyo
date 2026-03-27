import assert from 'node:assert/strict'
import test from 'node:test'

import type { SkillCatalogEntry } from '../../../shared/yachiyo/protocol.ts'
import { filterSkills } from './skillsPaneModel.ts'

const SKILLS: SkillCatalogEntry[] = [
  {
    name: 'agent-browser',
    description: 'Browser automation for scraping and testing web apps.',
    directoryPath: '/skills/agent-browser',
    skillFilePath: '/skills/agent-browser/SKILL.md'
  },
  {
    name: 'obsidian-cli',
    description: 'Manage notes and tasks in Obsidian vaults.',
    directoryPath: '/skills/obsidian-cli',
    skillFilePath: '/skills/obsidian-cli/SKILL.md'
  },
  {
    name: 'save-thread',
    description: undefined,
    directoryPath: '/skills/save-thread',
    skillFilePath: '/skills/save-thread/SKILL.md'
  }
]

test('filterSkills returns every skill for an empty query', () => {
  assert.deepEqual(filterSkills(SKILLS, ''), SKILLS)
  assert.deepEqual(filterSkills(SKILLS, '   '), SKILLS)
})

test('filterSkills matches skill names case-insensitively', () => {
  assert.deepEqual(filterSkills(SKILLS, 'BROWSER'), [SKILLS[0]])
  assert.deepEqual(filterSkills(SKILLS, 'thread'), [SKILLS[2]])
})

test('filterSkills matches descriptions case-insensitively', () => {
  assert.deepEqual(filterSkills(SKILLS, 'vaults'), [SKILLS[1]])
  assert.deepEqual(filterSkills(SKILLS, 'testing web'), [SKILLS[0]])
})

test('filterSkills excludes non-matching skills', () => {
  assert.deepEqual(filterSkills(SKILLS, 'missing'), [])
})
