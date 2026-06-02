import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../../../storage/memoryStorage.ts'
import { ThingDomain } from '../../things/thingDomain.ts'
import {
  buildThingContextBlock,
  extractThingMentionNames,
  resolveThingMentionsForUserQuery
} from './thingMentions.ts'

test('extracts Thing mentions while excluding headings and hex colors', () => {
  assert.deepEqual(
    extractThingMentionNames('# Heading\nContinue #raven-ui and color #fff plus #Raven_UI'),
    ['raven-ui']
  )
})

test('resolveThingMentionsForUserQuery does not auto-link the current thread', async () => {
  const storage = createInMemoryYachiyoStorage()
  const domain = new ThingDomain({
    storage,
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })
  await domain.createThing({ name: 'raven-ui', summary: 'UI work' })

  await resolveThingMentionsForUserQuery({
    content: 'Continue #raven-ui',
    thingDomain: domain,
    threadId: 'thread-current'
  })

  assert.deepEqual((await domain.getThing('raven-ui'))?.sources, [])
})

test('hidden context block contains source previews, references, and querySource guidance', () => {
  const block = buildThingContextBlock([
    {
      name: 'raven-ui',
      resolved: true,
      thing: {
        id: 'thing-1',
        name: 'raven-ui',
        summary: 'UI work',
        lastUpdatedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        isInactive: false,
        sources: [
          {
            id: 'source-1',
            thingId: 'thing-1',
            threadId: 'thread-1',
            sourceRowId: 'thread_message:thread-1:message-1',
            preview: 'Conversation preview',
            createdAt: '2026-06-01T00:00:00.000Z'
          }
        ]
      }
    }
  ])

  assert.ok(block?.includes('Sources:'))
  assert.ok(block?.includes('Conversation preview'))
  assert.ok(block?.includes('sourceRowId: thread_message:thread-1:message-1'))
  assert.ok(block?.includes('querySource'))
  assert.equal(block?.includes('Source quotes:'), false)
  assert.equal(block?.includes('main language of the included chats/source quotes'), false)
})
