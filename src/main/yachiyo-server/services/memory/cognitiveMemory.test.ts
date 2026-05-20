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
