import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildThingMentionCompletionCommands,
  getThingMentionQuery
} from './thingMentionCompletion.ts'

test('Thing mention completions filter inactive Things and match slug query', () => {
  const commands = buildThingMentionCompletionCommands({
    query: 'rav',
    things: [
      makeThing('1', 'raven-ui', false),
      makeThing('2', 'raven-archive', true),
      makeThing('3', 'other', false)
    ]
  })

  assert.deepEqual(
    commands.map((command) => command.label),
    ['#raven-ui']
  )
  assert.equal(commands[0]?.description, 'Summary for raven-ui')
})

test('Thing mention query is read from cursor token', () => {
  assert.equal(getThingMentionQuery('continue #raven', 'continue #raven'.length), 'raven')
  assert.equal(getThingMentionQuery('not here', 'not here'.length), null)
})

function makeThing(
  id: string,
  name: string,
  isInactive: boolean
): {
  id: string
  name: string
  summary: string
  lastUpdatedAt: string
  createdAt: string
  updatedAt: string
  sources: []
  isInactive: boolean
} {
  return {
    id,
    name,
    summary: `Summary for ${name}`,
    lastUpdatedAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    sources: [],
    isInactive
  }
}
