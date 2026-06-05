import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { ThingDomain } from '../../app/domain/things/thingDomain.ts'
import { createTool } from './reviewThingsTool.ts'

type TestToolExecute = (
  input: unknown,
  options: unknown
) => Promise<{
  content?: Array<{ type: 'text'; text: string }>
  error?: string
  details?: unknown
}>

function outputText(output: Awaited<ReturnType<TestToolExecute>>): string {
  return output.content?.map((item) => item.text).join('\n') ?? ''
}

function createReviewThingsTool(): { execute: TestToolExecute } {
  const domain = new ThingDomain({
    storage: createInMemoryYachiyoStorage(),
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })
  const thingTool = createTool({ thingDomain: domain })
  const execute = thingTool.execute as unknown as TestToolExecute
  return { execute }
}

function reviewInput(action: string, args: Record<string, unknown>): unknown {
  return { action, arguments: JSON.stringify(args) }
}

test('reviewThings addReviewedSource derives source refs from a thread span rowId', async () => {
  const { execute } = createReviewThingsTool()
  await execute(reviewInput('create', { name: 'Raven UI', summary: 'UI work' }), {
    toolCallId: 't',
    messages: []
  })

  const output = await execute(
    reviewInput('addReviewedSource', {
      name: 'raven-ui',
      sourceRowId: 'thread_span:thread-1:start-message:end-message',
      preview: 'Reviewed conversation about source previews.'
    }),
    { toolCallId: 't', messages: [] }
  )

  assert.equal(output.error, undefined)
  assert.match(outputText(output), /#raven-ui/)
  assert.match(outputText(output), /Sources: 1/)
  assert.match(outputText(output), /Reviewed conversation about source previews\./)
  assert.match(outputText(output), /spanRowId: thread_span:thread-1:start-message:end-message/)
  assert.deepEqual((output.details as { thing: { sources: unknown[] } }).thing.sources, [
    {
      id: (
        (output.details as { thing: { sources: Array<{ id: string }> } }).thing.sources[0] as {
          id: string
        }
      ).id,
      thingId: (output.details as { thing: { id: string } }).thing.id,
      threadId: 'thread-1',
      spanRowId: 'thread_span:thread-1:start-message:end-message',
      sourceRowId: 'thread_span:thread-1:start-message:end-message',
      preview: 'Reviewed conversation about source previews.',
      createdAt: '2026-06-01T00:00:00.000Z'
    }
  ])
})

test('reviewThings list and get expose model-visible Thing details', async () => {
  const { execute } = createReviewThingsTool()
  await execute(reviewInput('create', { name: 'Raven UI', summary: 'UI work' }), {
    toolCallId: 't',
    messages: []
  })
  await execute(
    reviewInput('addReviewedSource', {
      name: 'raven-ui',
      sourceRowId: 'thread_message:thread-1:message-1',
      preview: 'Reviewed one message.'
    }),
    { toolCallId: 't', messages: [] }
  )

  const listOutput = await execute(
    reviewInput('list', {
      includeInactive: true,
      name: '',
      summary: '',
      sourceRowId: '',
      preview: ''
    }),
    { toolCallId: 't', messages: [] }
  )
  assert.match(outputText(listOutput), /#raven-ui/)
  assert.match(outputText(listOutput), /UI work/)
  assert.match(outputText(listOutput), /1 source/)

  const getOutput = await execute(reviewInput('get', { name: 'raven-ui' }), {
    toolCallId: 't',
    messages: []
  })
  assert.match(outputText(getOutput), /#raven-ui/)
  assert.match(outputText(getOutput), /Status: active/)
  assert.match(outputText(getOutput), /Summary: UI work/)
  assert.match(outputText(getOutput), /Sources: 1/)
  assert.match(outputText(getOutput), /Reviewed one message\./)
  assert.match(outputText(getOutput), /messageId: message-1/)
})

test('reviewThings addReviewedSource derives source refs from a thread message rowId', async () => {
  const { execute } = createReviewThingsTool()
  await execute(reviewInput('create', { name: 'Raven UI', summary: 'UI work' }), {
    toolCallId: 't',
    messages: []
  })

  const output = await execute(
    reviewInput('addReviewedSource', {
      name: 'raven-ui',
      sourceRowId: 'source_event:thread_message:thread-1:message-1',
      preview: 'Reviewed one message.'
    }),
    { toolCallId: 't', messages: [] }
  )

  assert.equal(output.error, undefined)
  assert.deepEqual((output.details as { thing: { sources: unknown[] } }).thing.sources, [
    {
      id: (
        (output.details as { thing: { sources: Array<{ id: string }> } }).thing.sources[0] as {
          id: string
        }
      ).id,
      thingId: (output.details as { thing: { id: string } }).thing.id,
      threadId: 'thread-1',
      messageId: 'message-1',
      sourceRowId: 'thread_message:thread-1:message-1',
      preview: 'Reviewed one message.',
      createdAt: '2026-06-01T00:00:00.000Z'
    }
  ])
})

test('reviewThings addReviewedSource rejects non-thread source rowIds', async () => {
  const { execute } = createReviewThingsTool()
  await execute(reviewInput('create', { name: 'Raven UI', summary: 'UI work' }), {
    toolCallId: 't',
    messages: []
  })

  const output = await execute(
    reviewInput('addReviewedSource', {
      name: 'raven-ui',
      sourceRowId: 'activity_record:activity-1',
      preview: 'Not a thread source.'
    }),
    { toolCallId: 't', messages: [] }
  )

  assert.match(output.error ?? '', /thread source/i)
})
