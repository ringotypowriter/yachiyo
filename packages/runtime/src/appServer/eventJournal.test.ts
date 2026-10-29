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

test('binary events fit the byte budget and replay owns its values', () => {
  const journal = new AppEventJournal('instance', 4096)
  const initial = journal.cursor()
  const bytes = new Uint8Array(2048).fill(255)
  const event = { type: 'attachment.ready', bytes, label: '附件', optional: undefined }
  journal.publish(event)
  bytes.fill(0)
  event.label = 'changed'
  const first = journal.replay(initial)
  assert.equal(first.reset, false)
  const expected = {
    type: 'attachment.ready',
    bytes: new Uint8Array(2048).fill(255),
    label: '附件',
    optional: undefined
  }
  assert.deepEqual(
    first.events.map(({ event }) => event),
    [expected]
  )
  const replayed = first.events[0].event as typeof event
  replayed.bytes.fill(42)
  replayed.label = 'mutated replay'
  first.events[0].cursor.sequence = 1000
  assert.deepEqual(journal.replay(initial).events, [
    { cursor: { instanceId: 'instance', sequence: 1 }, event: expected }
  ])

  const retained = journal.cursor()
  journal.publish({ type: 'message.delta', delta: 'x'.repeat(8192) })
  assert.equal(journal.replay(retained).reset, true)
  const afterOversized = journal.cursor()
  journal.publish({ type: 'message.delta', delta: 'next' })
  assert.deepEqual(journal.replay(afterOversized), {
    cursor: { instanceId: 'instance', sequence: 3 },
    reset: false,
    events: [
      {
        cursor: { instanceId: 'instance', sequence: 3 },
        event: { type: 'message.delta', delta: 'next' }
      }
    ]
  })
})
