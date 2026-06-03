import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { ThingDomain, normalizeThingName } from './thingDomain.ts'

test('normalizes Thing names to lower-kebab slugs', () => {
  assert.equal(normalizeThingName('#Raven_UI'), 'raven-ui')
})

test('creates Things as summary-only records and resolves only non-inactive Things', async () => {
  let now = new Date('2026-06-01T00:00:00.000Z')
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({ storage, now: () => now })

  const created = await domain.createThing({ name: '#Raven_UI', summary: 'UI work' })
  assert.equal(created.name, 'raven-ui')
  assert.equal(created.summary, 'UI work')
  assert.deepEqual(created.sources, [])

  await domain.upsertSource({
    name: 'raven-ui',
    threadId: 'thread-1',
    sourceRowId: 'thread_message:thread-1:message-1',
    preview: 'Main points from this conversation.'
  })

  const resolved = await domain.resolveThingMention('raven-ui')
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.thing?.sources.length, 1)
  assert.equal(resolved.thing?.sources[0]?.sourceRowId, 'thread_message:thread-1:message-1')
  assert.equal(resolved.thing?.sources[0]?.preview, 'Main points from this conversation.')

  now = new Date('2026-06-04T00:00:00.001Z')
  const inactive = await domain.resolveThingMention('raven-ui')
  assert.equal(inactive.resolved, false)
  assert.equal(inactive.reason, 'inactive')
})

test('upsertSource updates an existing source preview instead of duplicating it', async () => {
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({
    storage,
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })

  await domain.createThing({ name: 'raven-ui', summary: 'UI work' })
  await domain.upsertSource({
    name: 'raven-ui',
    threadId: 'thread-1',
    sourceRowId: 'thread_message:thread-1:message-1',
    preview: 'Old preview'
  })
  const updated = await domain.upsertSource({
    name: 'raven-ui',
    threadId: 'thread-1',
    sourceRowId: 'thread_message:thread-1:message-1',
    preview: 'Updated preview'
  })

  assert.equal(updated?.sources.length, 1)
  assert.equal(updated?.sources[0]?.preview, 'Updated preview')
})

test('lists Thing sources newest first', async () => {
  let now = new Date('2026-06-01T00:00:00.000Z')
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({ storage, now: () => now })

  await domain.createThing({ name: 'raven-ui', summary: 'UI work' })
  await domain.upsertSource({
    name: 'raven-ui',
    threadId: 'thread-1',
    sourceRowId: 'thread_message:thread-1:message-1',
    preview: 'Older source'
  })

  now = new Date('2026-06-01T00:01:00.000Z')
  const updated = await domain.upsertSource({
    name: 'raven-ui',
    threadId: 'thread-2',
    sourceRowId: 'thread_message:thread-2:message-2',
    preview: 'Newer source'
  })

  assert.deepEqual(
    updated?.sources.map((source) => source.preview),
    ['Newer source', 'Older source']
  )
})

test('removeSource removes one saved source without deleting the Thing', async () => {
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({
    storage,
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })

  const thing = await domain.createThing({ name: 'raven-ui', summary: 'UI work' })
  await domain.upsertSource({
    name: thing.name,
    threadId: 'thread-1',
    sourceRowId: 'thread_message:thread-1:message-1',
    preview: 'First source'
  })
  const withSources = await domain.upsertSource({
    name: thing.name,
    threadId: 'thread-2',
    sourceRowId: 'thread_message:thread-2:message-2',
    preview: 'Second source'
  })
  const firstSourceId = withSources?.sources[0]?.id
  assert.ok(firstSourceId)

  const removed = await domain.removeSource({ name: thing.name, sourceId: firstSourceId })

  assert.equal(removed, true)
  const current = await domain.getThing(thing.name)
  assert.equal(current?.sources.length, 1)
  assert.equal(current?.sources[0]?.preview, 'Second source')
})

test('restoreThing refreshes inactive Things', async () => {
  let now = new Date('2026-06-01T00:00:00.000Z')
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({ storage, now: () => now })

  await domain.createThing({ name: 'raven-ui', summary: 'UI work' })
  now = new Date('2026-06-04T00:00:00.001Z')
  assert.equal((await domain.getThing('raven-ui'))?.isInactive, true)

  const restored = await domain.restoreThing('raven-ui')

  assert.equal(restored?.isInactive, false)
  assert.equal(restored?.lastUpdatedAt, '2026-06-04T00:00:00.001Z')
})

test('deletes a Thing and its saved sources', async () => {
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({
    storage,
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })

  const thing = await domain.createThing({ name: 'raven-ui', summary: 'UI work' })
  await domain.upsertSource({
    name: thing.name,
    threadId: 'thread-1',
    sourceRowId: 'thread_message:thread-1:message-1',
    preview: 'Main points from this conversation.'
  })

  const deleted = await domain.deleteThing('raven-ui')

  assert.equal(deleted, true)
  assert.equal(await domain.getThing('raven-ui'), undefined)
  assert.deepEqual(storage.listThingSources(thing.id), [])
})
