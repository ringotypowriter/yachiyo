import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activateCognitiveRows,
  applyCognitivePatchToState,
  createEmptyCognitiveMemoryState,
  renderCognitiveRowMemoryEntry,
  type CognitivePatch
} from './cognitiveMemory.ts'

const NOW = '2026-05-19T02:30:00.000Z'

function evidence(messageId: string): CognitivePatch['operations'][number]['evidence'] {
  return [{ kind: 'message', threadId: 'thread-1', messageId }]
}

test('cognitive patches materialize relation rows with activation surfaces and evidence', () => {
  const state = createEmptyCognitiveMemoryState()
  const patch: CognitivePatch = {
    operations: [
      {
        type: 'upsertRelation',
        relation: 'agent_workflow_roles',
        purpose: 'Track how coding agents are used in Ringo workflow.',
        columns: [
          { name: 'agent', description: 'Agent name' },
          { name: 'role', description: 'Stable role' },
          { name: 'handoff_rule', description: 'How Yachiyo should hand work off' }
        ],
        evidence: evidence('m1')
      },
      {
        type: 'upsertRow',
        relation: 'agent_workflow_roles',
        key: 'codex',
        values: {
          agent: 'Codex',
          role: 'Explorer',
          handoff_rule: 'Produce dense context artifacts before implementation.'
        },
        subjects: ['Codex'],
        aliases: ['codex explorer'],
        triggers: ['deep codebase reading', 'context artifact'],
        scope: { workspacePath: '/Users/ringotypowriter/projects/yachiyo' },
        confidence: 0.86,
        evidence: evidence('m2')
      }
    ]
  }

  const next = applyCognitivePatchToState(state, patch, {
    createId: () => 'event-1',
    now: NOW
  })

  assert.equal(next.relations.length, 1)
  assert.equal(next.rows.length, 1)
  assert.equal(next.events.length, 2)
  assert.equal(next.relations[0]?.name, 'agent_workflow_roles')
  assert.deepEqual(
    next.relations[0]?.columns.map((column) => column.name),
    ['agent', 'role', 'handoff_rule']
  )
  assert.equal(next.rows[0]?.relation, 'agent_workflow_roles')
  assert.equal(next.rows[0]?.key, 'codex')
  assert.deepEqual(next.rows[0]?.evidence, evidence('m2'))
  assert.match(next.rows[0]?.activationText ?? '', /codex explorer/)
  assert.match(next.rows[0]?.activationText ?? '', /context artifact/)
})

test('cognitive patches soft-forget old low-frequency weakly evidenced rows', () => {
  const oldState = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'project_context',
          purpose: 'Track project context.',
          columns: ['note'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'project_context',
          key: 'minor_observation',
          values: { note: 'A one-off low-value detail.' },
          subjects: ['minor observation'],
          confidence: 0.95,
          evidence: evidence('m2')
        }
      ]
    },
    {
      createId: () => 'old-event',
      now: '2026-04-01T00:00:00.000Z'
    }
  )

  const next = applyCognitivePatchToState(
    oldState,
    { operations: [] },
    {
      createId: () => 'forget-event',
      now: NOW
    }
  )

  const row = next.rows.find((candidate) => candidate.key === 'minor_observation')
  assert.equal(row?.status, 'deprecated')
  assert.match(row?.triggers.join(' ') ?? '', /Automatic forgetting/)
  assert.equal(next.events.at(-1)?.operation.type, 'deprecateRow')
})

test('cognitive forgetting preserves protected, manual, active, or cross-thread rows', () => {
  const oldState = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'user_preferences',
          purpose: 'Track user preferences.',
          columns: ['preference'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRelation',
          relation: 'project_context',
          purpose: 'Track project context.',
          columns: ['note'],
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'user_preferences',
          key: 'protected_preference',
          values: { preference: 'Protected even if old.' },
          subjects: ['protected preference'],
          confidence: 0.7,
          evidence: evidence('m3')
        },
        {
          type: 'upsertRow',
          relation: 'project_context',
          key: 'manual_note',
          values: { note: 'Manual memories are user-intended.' },
          subjects: ['manual note'],
          confidence: 0.7,
          evidence: [{ kind: 'manual', note: 'Explicit remember tool write.' }]
        },
        {
          type: 'upsertRow',
          relation: 'project_context',
          key: 'active_note',
          values: { note: 'Activated more than once.' },
          subjects: ['active note'],
          confidence: 0.7,
          evidence: evidence('m4')
        },
        {
          type: 'upsertRow',
          relation: 'project_context',
          key: 'cross_thread_note',
          values: { note: 'Supported by more than one conversation.' },
          subjects: ['cross thread note'],
          confidence: 0.7,
          evidence: [
            { kind: 'message', threadId: 'thread-1', messageId: 'm5' },
            { kind: 'message', threadId: 'thread-1', messageId: 'm6' },
            { kind: 'message', threadId: 'thread-2', messageId: 'm7' }
          ]
        }
      ]
    },
    {
      createId: () => 'old-event',
      now: '2026-04-01T00:00:00.000Z'
    }
  )
  const activeRow = oldState.rows.find((row) => row.key === 'active_note')
  if (activeRow) activeRow.activationCount = 2

  const next = applyCognitivePatchToState(
    oldState,
    { operations: [] },
    {
      createId: () => 'forget-event',
      now: NOW
    }
  )

  assert.equal(next.rows.find((row) => row.key === 'protected_preference')?.status, 'active')
  assert.equal(next.rows.find((row) => row.key === 'manual_note')?.status, 'active')
  assert.equal(next.rows.find((row) => row.key === 'active_note')?.status, 'active')
  assert.equal(next.rows.find((row) => row.key === 'cross_thread_note')?.status, 'active')
  assert.equal(next.events.length, oldState.events.length)
})

test('cognitive row activation ignores stale history when the current query has no direct match', () => {
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'external_repositories',
          purpose: 'Track upstream repository maintenance.',
          columns: ['local_path', 'upstream_remote', 'tracking_status', 'notes'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'external_repositories',
          key: 'sample_upstream',
          values: {
            local_path: 'sample-project',
            upstream_remote: 'example/sample-project',
            tracking_status: 'active via Upstream Watch schedule',
            notes: 'Local HEAD lags behind upstream by 5 commits'
          },
          subjects: ['sample upstream'],
          triggers: ['Upstream Watch', 'example/sample-project'],
          confidence: 0.95,
          evidence: evidence('m2')
        }
      ]
    },
    {
      createId: () => 'event-1',
      now: NOW
    }
  )

  const activated = activateCognitiveRows(state, {
    history: [
      {
        id: 'm1',
        threadId: 'thread-1',
        role: 'user',
        content: 'sample upstream watch 的状态是什么？',
        status: 'completed',
        createdAt: NOW
      },
      {
        id: 'm2',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'sample-project lags behind upstream by 5 commits.',
        status: 'completed',
        createdAt: NOW
      }
    ],
    limit: 4,
    now: NOW,
    thread: {
      id: 'thread-1',
      title: 'General chat',
      updatedAt: NOW
    },
    userQuery: '这个甚至不是主要结果，你到底看懂了什么'
  })

  assert.deepEqual(activated, [])
})

test('cognitive row activation is deterministic and excludes deprecated rows', () => {
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'agent_workflow_roles',
          purpose: 'Track agent roles.',
          columns: ['agent', 'role', 'handoff_rule'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'agent_workflow_roles',
          key: 'codex',
          values: { agent: 'Codex', role: 'Explorer' },
          subjects: ['Codex'],
          aliases: ['codebase explorer'],
          triggers: ['deep reading', 'context artifact'],
          confidence: 0.9,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'agent_workflow_roles',
          key: 'old-agent',
          values: { agent: 'Old Agent', role: 'Deprecated' },
          subjects: ['Old Agent'],
          triggers: ['context artifact'],
          confidence: 0.9,
          evidence: evidence('m3')
        },
        {
          type: 'deprecateRow',
          relation: 'agent_workflow_roles',
          key: 'old-agent',
          reason: 'No longer part of the workflow.',
          evidence: evidence('m4')
        }
      ]
    },
    {
      createId: () => 'event-1',
      now: NOW
    }
  )

  const activated = activateCognitiveRows(state, {
    history: [],
    limit: 4,
    now: NOW,
    thread: {
      id: 'thread-1',
      title: 'Agent workflow',
      updatedAt: NOW,
      workspacePath: '/Users/ringotypowriter/projects/yachiyo'
    },
    userQuery: 'Codex 是不是负责 deep reading 和 context artifact？'
  })

  assert.deepEqual(
    activated.map((row) => row.key),
    ['codex']
  )
  assert.equal(
    renderCognitiveRowMemoryEntry(activated[0]!),
    '[agent_workflow_roles] codex: agent=Codex; role=Explorer'
  )
})
