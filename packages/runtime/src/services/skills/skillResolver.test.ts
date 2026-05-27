import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveActiveSkills } from './skillResolver.ts'

const AVAILABLE_SKILLS = [
  {
    name: 'workspace-refactor',
    description: 'Workspace refactor guide',
    directoryPath: '/workspace/.yachiyo/skills/workspace-refactor',
    skillFilePath: '/workspace/.yachiyo/skills/workspace-refactor/SKILL.md',
    autoEnabled: true
  },
  {
    name: 'release-checklist',
    description: 'Release checklist',
    directoryPath: '/home/.codex/skills/release-checklist',
    skillFilePath: '/home/.codex/skills/release-checklist/SKILL.md'
  }
]

test('resolveActiveSkills uses settings defaults when no composer override is present', () => {
  const activeSkills = resolveActiveSkills({
    availableSkills: AVAILABLE_SKILLS,
    config: {
      providers: [],
      skills: {
        enabled: ['release-checklist']
      }
    }
  })

  assert.deepEqual(activeSkills, [
    {
      name: 'workspace-refactor',
      description: 'Workspace refactor guide'
    },
    {
      name: 'release-checklist',
      description: 'Release checklist'
    }
  ])
})

test('resolveActiveSkills lets composer override settings defaults for one run', () => {
  const activeSkills = resolveActiveSkills({
    availableSkills: AVAILABLE_SKILLS,
    config: {
      providers: [],
      skills: {
        enabled: ['release-checklist']
      }
    },
    enabledSkillNames: ['workspace-refactor']
  })

  assert.deepEqual(activeSkills, [
    {
      name: 'workspace-refactor',
      description: 'Workspace refactor guide'
    }
  ])
})

test('autoEnabled skills are active even without being in the enabled list', () => {
  const activeSkills = resolveActiveSkills({
    availableSkills: AVAILABLE_SKILLS,
    config: {
      providers: [],
      skills: { enabled: [] }
    }
  })

  assert.deepEqual(activeSkills, [
    {
      name: 'workspace-refactor',
      description: 'Workspace refactor guide'
    }
  ])
})

test('autoEnabled skills can be explicitly disabled', () => {
  const activeSkills = resolveActiveSkills({
    availableSkills: AVAILABLE_SKILLS,
    config: {
      providers: [],
      skills: {
        enabled: ['release-checklist'],
        disabled: ['workspace-refactor']
      }
    }
  })

  assert.deepEqual(activeSkills, [
    {
      name: 'release-checklist',
      description: 'Release checklist'
    }
  ])
})

test('composer override can exclude autoEnabled skills from a run', () => {
  const activeSkills = resolveActiveSkills({
    availableSkills: AVAILABLE_SKILLS,
    config: {
      providers: [],
      skills: { enabled: ['release-checklist'] }
    },
    enabledSkillNames: ['release-checklist']
  })

  assert.deepEqual(activeSkills, [
    {
      name: 'release-checklist',
      description: 'Release checklist'
    }
  ])
})

test('non-autoEnabled skills are not active unless explicitly enabled', () => {
  const activeSkills = resolveActiveSkills({
    availableSkills: AVAILABLE_SKILLS,
    config: {
      providers: [],
      skills: { enabled: [] }
    }
  })

  assert.ok(!activeSkills.some((s) => s.name === 'release-checklist'))
})
