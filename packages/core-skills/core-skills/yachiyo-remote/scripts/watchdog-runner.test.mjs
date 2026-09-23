import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeWrites } from './watchdog.mjs'

test('delayed pre-restart publication cannot overwrite a newer stopped state', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const written = []
  const publish = serializeWrites(async (snapshot) => {
    if (snapshot.reason === 'restarting') await gate
    written.push(snapshot)
  })
  const pending = publish({ reason: 'restarting', budget: 1, running: true })
  const failed = publish({ reason: 'restart-failed', budget: 1, running: true })
  const stopped = publish({ reason: 'stopped', budget: 1, running: false })
  await Promise.resolve()
  assert.deepEqual(written, [])
  release()
  await Promise.all([pending, failed, stopped])
  assert.deepEqual(
    written.map((state) => state.reason),
    ['restarting', 'restart-failed', 'stopped']
  )
  assert.equal(written.at(-1).running, false)
  assert.equal(written.at(-1).budget, 1)
})

test('a failed publication does not prevent the next checkpoint from being saved', async () => {
  const written = []
  const publish = serializeWrites(async (value) => {
    if (value === 'failed') throw new Error('disk failure')
    written.push(value)
  })
  const first = publish('failed')
  const second = publish('latest')
  await assert.rejects(first, /disk failure/)
  await second
  assert.deepEqual(written, ['latest'])
})
