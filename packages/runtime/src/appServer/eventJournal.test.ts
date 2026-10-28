import assert from 'node:assert/strict'
import test from 'node:test'
import { AppEventJournal } from './eventJournal.ts'

test('replay retains published values and explicitly resets cursors beyond retention', () => {
  const journal = new AppEventJournal('instance', 1024, 2)
  const initial = journal.cursor()
  const event = { type: 'tool.updated', details: { status: 'running' } }
  journal.publish(event)
  event.details.status = 'completed'
  assert.deepEqual(journal.replay(initial).events[0].event, {
    type: 'tool.updated',
    details: { status: 'running' }
  })
  const retained = journal.cursor()
  journal.publish({ type: 'message.delta', delta: 'a' })
  journal.publish({ type: 'message.delta', delta: 'b' })
  assert.equal(journal.replay(initial).reset, true)
  assert.deepEqual(
    journal.replay(retained).events.map(({ event }) => event),
    [
      { type: 'message.delta', delta: 'a' },
      { type: 'message.delta', delta: 'b' }
    ]
  )
})
