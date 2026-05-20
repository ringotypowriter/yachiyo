import assert from 'node:assert/strict'
import test from 'node:test'

import type { CognitiveMemoryState, CognitiveRow } from './cognitiveMemory.ts'
import {
  createInMemoryCognitiveMemoryStore,
  readCognitiveMemoryTermDocument
} from './cognitiveMemoryStore.ts'

const NOW = '2026-05-19T10:00:00.000Z'

function row(relation: string, key: string): CognitiveRow {
  return {
    id: `${relation}-${key}`,
    relation,
    key,
    values: { value: key },
    subjects: [],
    aliases: [],
    triggers: [],
    scope: {},
    evidence: [],
    confidence: 0.8,
    status: 'active',
    activationText: key,
    activationCount: 0,
    createdAt: NOW,
    updatedAt: NOW
  }
}

test('in-memory cognitive store tracks activated rows and supports hard deletion', async () => {
  const store = createInMemoryCognitiveMemoryStore({
    events: [],
    relations: [],
    rows: [
      {
        ...row('agent_workflow_roles', 'codex'),
        subjects: ['Codex'],
        triggers: ['context artifact'],
        activationText: 'agent workflow roles codex context artifact'
      }
    ]
  })

  await store.activateRows({
    history: [],
    limit: 4,
    now: '2026-05-20T00:00:00.000Z',
    thread: { id: 'thread-1', title: 'Agent workflow', updatedAt: NOW },
    userQuery: 'Codex context artifact'
  })

  const activatedState = await store.readState()
  assert.equal(activatedState.rows[0]?.activationCount, 1)
  assert.equal(activatedState.rows[0]?.lastActivatedAt, '2026-05-20T00:00:00.000Z')

  const deleted = await store.deleteRow({ id: 'agent_workflow_roles-codex' })
  assert.equal(deleted.deleted, true)
  assert.equal((await store.readState()).rows.length, 0)
})

test('readCognitiveMemoryTermDocument returns a paginated term document with total counts', async () => {
  const state: CognitiveMemoryState = {
    events: [],
    relations: [
      {
        id: 'rel-a',
        name: 'topic-a',
        purpose: '',
        columns: [],
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: 'rel-b',
        name: 'topic-b',
        purpose: '',
        columns: [],
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    rows: [row('topic-a', 'a'), row('topic-a', 'b'), row('topic-b', 'a')]
  }

  const document = await readCognitiveMemoryTermDocument({
    store: createInMemoryCognitiveMemoryStore(state),
    limit: 1,
    offset: 2
  })

  assert.equal(document.memoryCount, 3)
  assert.equal(document.topicCount, 2)
  assert.equal(document.topics.length, 1)
  assert.equal(document.topics[0]?.topic, 'topic-b')
  assert.equal(document.topics[0]?.entryCount, 1)
  assert.equal(document.topics[0]?.entries[0]?.title, 'a')
})
