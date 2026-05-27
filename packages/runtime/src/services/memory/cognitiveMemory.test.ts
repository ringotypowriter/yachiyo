import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activateCognitiveRows,
  applyCognitivePatchToState,
  createEmptyCognitiveMemoryState,
  diffuseCognitiveRows,
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

test('cognitive row activation requires a distinctive cue match', () => {
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'sample_behavior',
          purpose: 'Track sample behavior.',
          columns: ['note'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'sample_behavior',
          key: 'alpha_bridge_rule',
          values: { note: 'Use the sample bridge when the alpha path is requested.' },
          subjects: ['sample alpha bridge'],
          aliases: ['alpha bridge'],
          triggers: ['bridge override'],
          confidence: 0.85,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'sample_behavior',
          key: 'generic_shared_note',
          values: { note: 'The alpha bridge wording appears in this body only.' },
          subjects: ['shared cue'],
          confidence: 1,
          evidence: evidence('m3')
        },
        {
          type: 'upsertRow',
          relation: 'sample_behavior',
          key: 'another_shared_note',
          values: { note: 'Another row carries the same shared cue.' },
          subjects: ['shared cue'],
          confidence: 1,
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
      title: 'Sample thread',
      updatedAt: NOW
    },
    userQuery: 'Should the sample alpha bridge keep the shared cue behavior?'
  })

  assert.deepEqual(
    activated.map((row) => row.key),
    ['alpha_bridge_rule']
  )
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
    '[agent_workflow_roles] codex: agent=Codex; role=Explorer; source_threads=thread:thread-1; source_messages=thread_message:thread-1:m2'
  )
})

test('cognitive row memory entries expose source conversation row ids from evidence', () => {
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'project_context',
          purpose: 'Track project context.',
          columns: ['note'],
          evidence: [{ kind: 'thread', threadId: 'thread-a' }]
        },
        {
          type: 'upsertRow',
          relation: 'project_context',
          key: 'memory_source_bridge',
          values: { note: 'Memory recall should point back to its source conversation.' },
          subjects: ['memory source bridge'],
          confidence: 0.9,
          evidence: [
            { kind: 'message', threadId: 'thread-a', messageId: 'msg-1' },
            { kind: 'message', threadId: 'thread-a', messageId: 'msg-2' },
            { kind: 'thread', threadId: 'thread-b' },
            { kind: 'message', threadId: 'thread-a', messageId: 'msg-1' }
          ]
        }
      ]
    },
    {
      createId: () => 'event-1',
      now: NOW
    }
  )

  assert.equal(
    renderCognitiveRowMemoryEntry(state.rows[0]!),
    '[project_context] memory_source_bridge: note=Memory recall should point back to its source conversation.; source_threads=thread:thread-a, thread:thread-b; source_messages=thread_message:thread-a:msg-1, thread_message:thread-a:msg-2'
  )
})

test('diffusion filters out neighbors unrelated to the query', () => {
  let idCounter = 0
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'agent_config',
          purpose: 'Track agent config.',
          columns: ['setting'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRelation',
          relation: 'fruit_prefs',
          purpose: 'Track fruit preferences.',
          columns: ['note'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'agent_config',
          key: 'codex',
          values: { setting: 'Explorer' },
          subjects: ['Codex'],
          triggers: ['agent config'],
          confidence: 0.9,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'fruit_prefs',
          key: 'banana',
          values: { note: 'Likes bananas.' },
          subjects: ['banana'],
          triggers: ['fruit'],
          confidence: 0.9,
          evidence: evidence('m3')
        }
      ]
    },
    {
      createId: () => {
        idCounter += 1
        return `id-${idCounter}`
      },
      now: NOW
    }
  )

  const seeds = state.rows.filter((r) => r.key === 'codex')
  const diffused = diffuseCognitiveRows(state, seeds, 'agent config')

  assert.deepEqual(
    diffused.map((r) => r.key),
    []
  )
})

test('diffusion recalls neighbors that share subjects and match the query', () => {
  let idCounter = 0
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'agent_roles',
          purpose: 'Track agent roles.',
          columns: ['role'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRelation',
          relation: 'team_info',
          purpose: 'Track team info.',
          columns: ['member'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'codex',
          values: { role: 'Explorer' },
          subjects: ['Codex', 'agent'],
          triggers: ['config'],
          confidence: 0.9,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'team_info',
          key: 'ringo_team',
          values: { member: 'Ringo' },
          subjects: ['Codex', 'team'],
          triggers: ['member'],
          confidence: 0.9,
          evidence: evidence('m3')
        }
      ]
    },
    {
      createId: () => {
        idCounter += 1
        return `id-${idCounter}`
      },
      now: NOW
    }
  )

  const seeds = state.rows.filter((r) => r.key === 'codex')
  const diffused = diffuseCognitiveRows(state, seeds, 'agent codex config')

  assert.deepEqual(
    diffused.map((r) => r.key),
    ['ringo_team']
  )
})

test('diffusion filters out low-confidence neighbors', () => {
  let idCounter = 0
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'agent_roles',
          purpose: 'Track agent roles.',
          columns: ['role'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'codex',
          values: { role: 'Explorer' },
          subjects: ['Codex'],
          triggers: ['config'],
          confidence: 0.9,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'low_confidence_note',
          values: { role: 'Low' },
          subjects: ['Codex'],
          triggers: ['config'],
          confidence: 0.3,
          evidence: evidence('m3')
        }
      ]
    },
    {
      createId: () => {
        idCounter += 1
        return `id-${idCounter}`
      },
      now: NOW
    }
  )

  const seeds = state.rows.filter((r) => r.key === 'codex')
  const diffused = diffuseCognitiveRows(state, seeds, 'agent codex config')

  assert.deepEqual(
    diffused.map((r) => r.key),
    []
  )
})

test('diffusion limits to one neighbor per relation', () => {
  let idCounter = 0
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'agent_roles',
          purpose: 'Track agent roles.',
          columns: ['role'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRelation',
          relation: 'tool_prefs',
          purpose: 'Track tool preferences.',
          columns: ['tool'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'seed1',
          values: { role: 'A' },
          subjects: ['alpha'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'seed2',
          values: { role: 'B' },
          subjects: ['beta'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m3')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'neighbor_a1',
          values: { role: 'C' },
          subjects: ['alpha'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m4')
        },
        {
          type: 'upsertRow',
          relation: 'agent_roles',
          key: 'neighbor_a2',
          values: { role: 'D' },
          subjects: ['beta'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m5')
        },
        {
          type: 'upsertRow',
          relation: 'tool_prefs',
          key: 'neighbor_b1',
          values: { tool: 'X' },
          subjects: ['alpha'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m6')
        }
      ]
    },
    {
      createId: () => {
        idCounter += 1
        return `id-${idCounter}`
      },
      now: NOW
    }
  )

  const seeds = state.rows.filter((r) => r.key === 'seed1' || r.key === 'seed2')
  const diffused = diffuseCognitiveRows(state, seeds, 'alpha beta setup', 2)

  const keys = diffused.map((r) => r.key)
  assert.equal(keys.length, 2)
  assert.ok(keys.includes('neighbor_b1'), 'should include cross-relation neighbor')
  const relationACount = diffused.filter((r) => r.relation === 'agent_roles').length
  assert.equal(relationACount, 1, 'should include at most one neighbor from agent_roles')
})

test('diffusion depth-2 score is lower than depth-1 score', () => {
  let idCounter = 0
  const state = applyCognitivePatchToState(
    createEmptyCognitiveMemoryState(),
    {
      operations: [
        {
          type: 'upsertRelation',
          relation: 'chain_a',
          purpose: 'Chain test A.',
          columns: ['note'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRelation',
          relation: 'chain_b',
          purpose: 'Chain test B.',
          columns: ['note'],
          evidence: evidence('m1')
        },
        {
          type: 'upsertRow',
          relation: 'chain_a',
          key: 'seed',
          values: { note: 'Seed' },
          subjects: ['alpha'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m2')
        },
        {
          type: 'upsertRow',
          relation: 'chain_a',
          key: 'depth1',
          values: { note: 'Depth 1' },
          subjects: ['alpha', 'beta'],
          triggers: ['setup'],
          confidence: 0.9,
          evidence: evidence('m3')
        },
        {
          type: 'upsertRow',
          relation: 'chain_b',
          key: 'depth2',
          values: { note: 'Depth 2' },
          subjects: ['beta', 'gamma'],
          triggers: ['config'],
          confidence: 0.9,
          evidence: evidence('m4')
        }
      ]
    },
    {
      createId: () => {
        idCounter += 1
        return `id-${idCounter}`
      },
      now: NOW
    }
  )

  const seeds = state.rows.filter((r) => r.key === 'seed')
  const diffused = diffuseCognitiveRows(state, seeds, 'alpha beta gamma setup config', 3)

  const keys = diffused.map((r) => r.key)
  assert.ok(keys.includes('depth1'), 'depth1 should be diffused')
  assert.ok(keys.includes('depth2'), 'depth2 should be diffused')

  // depth1 has direct subject overlap with seed, so it should appear before depth2
  assert.ok(keys.indexOf('depth1') < keys.indexOf('depth2'), 'depth1 should rank before depth2')
})
