import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { ThingDomain } from '../../app/domain/things/thingDomain.ts'
import { createTool } from './useThingsTool.ts'

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

function createThingsTool(threadId = 'thread-current'): {
  domain: ThingDomain
  thingTool: ReturnType<typeof createTool>
  execute: TestToolExecute
} {
  const domain = new ThingDomain({
    storage: createInMemoryYachiyoStorage(),
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })
  const thingTool = createTool(
    { threadId, workspacePath: '/tmp/yachiyo-test' },
    { thingDomain: domain }
  )
  const execute = thingTool.execute as unknown as TestToolExecute
  return { domain, thingTool, execute }
}

test('useThings tool creates and lists Things', async () => {
  const { execute } = createThingsTool()

  await execute(
    { action: 'create', name: 'Raven UI', summary: 'UI work' },
    { toolCallId: 't', messages: [] }
  )
  const output = await execute({ action: 'list' }, { toolCallId: 't', messages: [] })

  assert.equal(output.error, undefined)
  assert.ok(JSON.stringify(output.details).includes('raven-ui'))
  assert.match(outputText(output), /#raven-ui/)
  assert.match(outputText(output), /UI work/)
  assert.match(outputText(output), /active/)

  const getOutput = await execute(
    { action: 'get', name: 'raven-ui' },
    { toolCallId: 't', messages: [] }
  )
  assert.match(outputText(getOutput), /#raven-ui/)
  assert.match(outputText(getOutput), /Status: active/)
  assert.match(outputText(getOutput), /Summary: UI work/)
  assert.match(outputText(getOutput), /Sources: 0/)
})

test('useThings addCurrentThreadSource derives the source from AgentToolContext.threadId', async () => {
  const { execute } = createThingsTool('thread-current')

  await execute(
    { action: 'create', name: 'Raven UI', summary: 'UI work' },
    { toolCallId: 't', messages: [] }
  )
  const output = await execute(
    {
      action: 'addCurrentThreadSource',
      name: 'raven-ui',
      preview: 'Current conversation discussed source preview semantics.'
    },
    { toolCallId: 't', messages: [] }
  )

  assert.equal(output.error, undefined)
  assert.match(outputText(output), /#raven-ui/)
  assert.match(outputText(output), /Sources: 1/)
  assert.match(outputText(output), /Current conversation discussed source preview semantics\./)
  assert.match(outputText(output), /sourceRowId: thread:thread-current/)
  assert.deepEqual((output.details as { thing: { sources: unknown[] } }).thing.sources, [
    {
      id: (
        (output.details as { thing: { sources: Array<{ id: string }> } }).thing.sources[0] as {
          id: string
        }
      ).id,
      thingId: (output.details as { thing: { id: string } }).thing.id,
      threadId: 'thread-current',
      sourceRowId: 'thread:thread-current',
      preview: 'Current conversation discussed source preview semantics.',
      createdAt: '2026-06-01T00:00:00.000Z'
    }
  ])
})

test('useThings input schema does not expose cross-thread source or quote actions', () => {
  const { thingTool } = createThingsTool()
  const schema = (
    thingTool as { inputSchema: { safeParse: (input: unknown) => { success: boolean } } }
  ).inputSchema

  assert.equal(
    schema.safeParse({ action: 'linkThread', name: 'raven-ui', threadId: 'other' }).success,
    false
  )
  assert.equal(
    schema.safeParse({ action: 'addQuote', name: 'raven-ui', quote: 'Exact quote' }).success,
    false
  )
  assert.equal(schema.safeParse({ action: 'dailyReview' }).success, false)
  assert.equal(
    schema.safeParse({
      action: 'addCurrentThreadSource',
      name: 'raven-ui',
      preview: 'Preview',
      threadId: 'other-thread'
    }).success,
    false
  )
  assert.equal(
    schema.safeParse({
      action: 'addCurrentThreadSource',
      name: 'raven-ui',
      preview: 'Preview',
      sourceRowId: 'thread:other-thread'
    }).success,
    false
  )
})
