import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolCallName } from '../../../../shared/yachiyo/protocol.ts'
import { buildContextSources } from './runExecution.ts'

const BASE_INPUT = {
  evolvedTraitCount: 0,
  hasUserContent: false,
  enabledTools: [] as ToolCallName[],
  activeSkills: [],
  fileMentionCount: 0,
  inlinedFileCount: 0,
  workspacePath: '/workspace',
  hasToolReminder: false,
  memoryEntries: [] as string[],
  recallDecision: undefined
}

test('buildContextSources always includes persona as present', () => {
  const sources = buildContextSources({ ...BASE_INPUT })

  const persona = sources.find((s) => s.kind === 'persona')
  assert.ok(persona, 'persona source must always be present')
  assert.equal(persona.present, true)
})

test('buildContextSources soul is present only when evolvedTraitCount > 0', () => {
  const withTraits = buildContextSources({ ...BASE_INPUT, evolvedTraitCount: 3 })
  const withoutTraits = buildContextSources({ ...BASE_INPUT, evolvedTraitCount: 0 })

  const withSoul = withTraits.find((s) => s.kind === 'soul')
  assert.ok(withSoul)
  assert.equal(withSoul.present, true)
  assert.equal(withSoul.count, 3)
  assert.equal(withSoul.summary, '3 traits')

  const withoutSoul = withoutTraits.find((s) => s.kind === 'soul')
  assert.ok(withoutSoul)
  assert.equal(withoutSoul.present, false)
})

test('buildContextSources soul summary uses singular for one trait', () => {
  const sources = buildContextSources({ ...BASE_INPUT, evolvedTraitCount: 1 })
  const soul = sources.find((s) => s.kind === 'soul')
  assert.ok(soul)
  assert.equal(soul.summary, '1 trait')
})

test('buildContextSources user present only when hasUserContent is true', () => {
  const withUser = buildContextSources({ ...BASE_INPUT, hasUserContent: true })
  const withoutUser = buildContextSources({ ...BASE_INPUT, hasUserContent: false })

  assert.equal(withUser.find((s) => s.kind === 'user')?.present, true)
  assert.equal(withoutUser.find((s) => s.kind === 'user')?.present, false)
})

test('buildContextSources agent is always present with tool count', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    enabledTools: ['bash', 'read', 'grep', 'glob'] as ToolCallName[]
  })

  const agent = sources.find((s) => s.kind === 'agent')
  assert.ok(agent)
  assert.equal(agent.present, true)
  assert.equal(agent.count, 4)
})

test('buildContextSources skills reflect only active skills', () => {
  const withSkills = buildContextSources({
    ...BASE_INPUT,
    activeSkills: [{ name: 'repo-skill', description: 'Local repo helper' }]
  })
  const withoutSkills = buildContextSources({ ...BASE_INPUT, activeSkills: [] })

  const skills = withSkills.find((s) => s.kind === 'skills')
  assert.ok(skills)
  assert.equal(skills.present, true)
  assert.equal(skills.count, 1)
  assert.equal(skills.summary, '1 skill active')

  assert.equal(withoutSkills.find((s) => s.kind === 'skills')?.present, false)
})

test('buildContextSources file mentions reflect referenced and inlined files', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    fileMentionCount: 2,
    inlinedFileCount: 1
  })

  const fileMentions = sources.find((s) => s.kind === 'fileMentions')
  assert.ok(fileMentions)
  assert.equal(fileMentions.present, true)
  assert.equal(fileMentions.count, 2)
  assert.equal(fileMentions.summary, '2 file references · 1 inlined')
})

test('buildContextSources agent summary includes workspace when workspacePath is non-empty', () => {
  const withWorkspace = buildContextSources({
    ...BASE_INPUT,
    enabledTools: ['bash'] as ToolCallName[],
    workspacePath: '/my/project'
  })
  const withoutWorkspace = buildContextSources({
    ...BASE_INPUT,
    enabledTools: ['bash'] as ToolCallName[],
    workspacePath: ''
  })

  assert.ok(withWorkspace.find((s) => s.kind === 'agent')?.summary?.includes('workspace'))
  assert.ok(!withoutWorkspace.find((s) => s.kind === 'agent')?.summary?.includes('workspace'))
})

test('buildContextSources does not include memory source when recallDecision is absent', () => {
  const sources = buildContextSources({ ...BASE_INPUT, recallDecision: undefined })

  assert.equal(
    sources.find((s) => s.kind === 'memory'),
    undefined
  )
})

test('buildContextSources memory present when shouldRecall is true', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    memoryEntries: ['entry one', 'entry two'],
    recallDecision: {
      shouldRecall: true,
      score: 0.9,
      reasons: ['thread-cold-start'],
      messagesSinceLastRecall: 0,
      charsSinceLastRecall: 0,
      idleMs: 0,
      noveltyScore: 0.9,
      novelTerms: []
    }
  })

  const memory = sources.find((s) => s.kind === 'memory')
  assert.ok(memory)
  assert.equal(memory.present, true)
  assert.equal(memory.count, 2)
  assert.deepEqual(memory.reasons, ['thread-cold-start'])
  assert.ok(memory.summary?.includes('recalled'))
})

test('buildContextSources memory not-present when shouldRecall is false', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    recallDecision: {
      shouldRecall: false,
      score: 0.1,
      reasons: [],
      messagesSinceLastRecall: 1,
      charsSinceLastRecall: 100,
      idleMs: 0,
      noveltyScore: 0.1,
      novelTerms: []
    }
  })

  const memory = sources.find((s) => s.kind === 'memory')
  assert.ok(memory)
  assert.equal(memory.present, false)
  assert.equal(memory.summary, 'not recalled')
})

test('buildContextSources memory count excludes blank entries', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    memoryEntries: ['valid entry', '   ', '', 'another entry'],
    recallDecision: {
      shouldRecall: true,
      score: 0.8,
      reasons: ['topic-novelty'],
      messagesSinceLastRecall: 5,
      charsSinceLastRecall: 500,
      idleMs: 0,
      noveltyScore: 0.8,
      novelTerms: []
    }
  })

  const memory = sources.find((s) => s.kind === 'memory')
  assert.ok(memory)
  assert.equal(memory.count, 2)
})

test('buildContextSources does not include toolReminder when hasToolReminder is false', () => {
  const sources = buildContextSources({ ...BASE_INPUT, hasToolReminder: false })

  assert.equal(
    sources.find((s) => s.kind === 'toolReminder'),
    undefined
  )
})

test('buildContextSources includes toolReminder when hasToolReminder is true', () => {
  const sources = buildContextSources({ ...BASE_INPUT, hasToolReminder: true })

  const reminder = sources.find((s) => s.kind === 'toolReminder')
  assert.ok(reminder)
  assert.equal(reminder.present, true)
})

test('buildContextSources includes activity when a summary was consumed', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    activitySummary: { uniqueApps: 2 }
  })

  const activity = sources.find((s) => s.kind === 'activity')
  assert.ok(activity)
  assert.equal(activity.present, true)
  assert.equal(activity.summary, '2 apps')
})

test('buildContextSources includes AFK duration in the activity summary label', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    activitySummary: { uniqueApps: 2, afkDurationMs: 56 * 60_000 }
  })

  const activity = sources.find((s) => s.kind === 'activity')
  assert.ok(activity)
  assert.equal(activity.summary, '2 apps · AFK 56min')
})

test('buildContextSources source order is persona, soul, user, skills, fileMentions, agent, memory, toolReminder, activity', () => {
  const sources = buildContextSources({
    ...BASE_INPUT,
    evolvedTraitCount: 1,
    hasUserContent: true,
    activeSkills: [{ name: 'repo-skill', description: 'Local repo helper' }],
    fileMentionCount: 1,
    enabledTools: ['bash'] as ToolCallName[],
    hasToolReminder: true,
    memoryEntries: ['entry'],
    recallDecision: {
      shouldRecall: true,
      score: 0.9,
      reasons: ['new-thread'],
      messagesSinceLastRecall: 0,
      charsSinceLastRecall: 0,
      idleMs: 0,
      noveltyScore: 0.9,
      novelTerms: []
    },
    activitySummary: { uniqueApps: 1 }
  })

  const kinds = sources.map((s) => s.kind)
  assert.deepEqual(kinds, [
    'persona',
    'soul',
    'user',
    'skills',
    'fileMentions',
    'agent',
    'memory',
    'toolReminder',
    'activity'
  ])
})
