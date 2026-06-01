import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { ThingDomain, normalizeThingName } from './thingDomain.ts'

test('normalizes Thing names to lower-kebab slugs', () => {
  assert.equal(normalizeThingName('#Raven_UI'), 'raven-ui')
})

test('creates, links, quotes, and resolves only non-inactive Things', async () => {
  let now = new Date('2026-06-01T00:00:00.000Z')
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({ storage, now: () => now })

  const created = await domain.createThing({ name: '#Raven_UI', summary: 'UI work' })
  assert.equal(created.name, 'raven-ui')
  assert.equal('primaryLanguage' in created, false)

  await domain.linkThread({ name: 'raven-ui', threadId: 'thread-1' })
  await domain.addQuote({
    name: 'raven-ui',
    threadId: 'thread-1',
    sourceRowId: 'thread_message:1',
    quote: 'Original quote'
  })

  const resolved = await domain.resolveThingMention('raven-ui')
  assert.equal(resolved.resolved, true)
  assert.equal(resolved.thing?.includedChats.length, 1)
  assert.equal(resolved.thing?.sourceQuotes[0]?.sourceRowId, 'thread_message:1')

  now = new Date('2026-06-04T00:00:00.000Z')
  const inactive = await domain.resolveThingMention('raven-ui')
  assert.equal(inactive.resolved, false)
  assert.equal(inactive.reason, 'inactive')
})
