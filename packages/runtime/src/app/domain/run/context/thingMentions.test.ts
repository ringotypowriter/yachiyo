import assert from 'node:assert/strict'
import test from 'node:test'

import { buildThingContextBlock, extractThingMentionNames } from './thingMentions.ts'

test('extracts Thing mentions while excluding headings and hex colors', () => {
  assert.deepEqual(
    extractThingMentionNames('# Heading\nContinue #raven-ui and color #fff plus #Raven_UI'),
    ['raven-ui']
  )
})

test('hidden context block contains quotes, references, and language reminder', () => {
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
        includedChats: [
          {
            thingId: 'thing-1',
            threadId: 'thread-1',
            threadTitle: 'Raven',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z'
          }
        ],
        sourceQuotes: [
          {
            id: 'quote-1',
            thingId: 'thing-1',
            threadId: 'thread-1',
            sourceRowId: 'thread_message:1',
            quote: 'Original quote',
            createdAt: '2026-06-01T00:00:00.000Z'
          }
        ]
      }
    }
  ])

  assert.ok(block?.includes('Original quote'))
  assert.ok(block?.includes('sourceRowId: thread_message:1'))
  assert.ok(block?.includes('main language of the included chats/source quotes'))
})
