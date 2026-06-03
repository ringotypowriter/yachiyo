import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { ThingDomain } from '../../app/domain/things/thingDomain.ts'
import { createTool, useThingsToolDescription } from './useThingsTool.ts'

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
  const rawExecute = thingTool.execute as unknown as TestToolExecute
  const execute: TestToolExecute = (input, options) =>
    rawExecute({ arguments: JSON.stringify(input) }, options)
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

test('useThings tool schema exposes only JSON arguments', async () => {
  const { execute, thingTool } = createThingsTool()
  const schema = (
    thingTool as { inputSchema: { safeParse: (input: unknown) => { success: boolean } } }
  ).inputSchema

  assert.equal(
    schema.safeParse({
      arguments: JSON.stringify({ action: 'get', name: 'raven-ui' }),
      includeInactive: false
    }).success,
    true
  )
  assert.equal(schema.safeParse({ action: 'get', name: 'raven-ui' }).success, false)

  assert.equal(
    (await execute({ action: 'linkThread', name: 'raven-ui', threadId: 'other' }, {})).error !=
      null,
    true
  )
  assert.equal(
    (await execute({ action: 'addQuote', name: 'raven-ui', quote: 'Exact quote' }, {})).error !=
      null,
    true
  )
  assert.equal((await execute({ action: 'dailyReview' }, {})).error != null, true)
  assert.equal(
    (
      await execute(
        {
          action: 'addCurrentThreadSource',
          name: 'raven-ui',
          preview: 'Preview',
          threadId: 'other-thread'
        },
        {}
      )
    ).error != null,
    true
  )
  assert.equal(
    (
      await execute(
        {
          action: 'addCurrentThreadSource',
          name: 'raven-ui',
          preview: 'Preview',
          sourceRowId: 'thread:other-thread'
        },
        {}
      )
    ).error != null,
    true
  )
})

test('useThings parser ignores empty fields inside JSON arguments', async () => {
  const { execute } = createThingsTool()

  const createOutput = await execute(
    {
      action: 'create',
      name: 'merge-workflow-test',
      summary: 'Test Thing for validating Things merge workflow behavior.',
      preview: undefined,
      sourceName: '',
      targetName: ''
    },
    {}
  )
  const sourceOutput = await execute(
    {
      action: 'addCurrentThreadSource',
      name: 'merge-workflow-test',
      preview: 'Current conversation belongs to the merge workflow test.',
      threadId: '',
      sourceRowId: null
    },
    {}
  )

  assert.equal(createOutput.error, undefined)
  assert.equal(sourceOutput.error, undefined)
  assert.match(outputText(sourceOutput), /Sources: 1/)
})

test('useThings description exposes primitives without merge workflow orchestration', () => {
  assert.match(useThingsToolDescription, /moveSources: move saved source previews/)
  assert.match(useThingsToolDescription, /delete: delete one Thing/)
  assert.doesNotMatch(useThingsToolDescription, /Merge workflow:/)
  assert.doesNotMatch(useThingsToolDescription, /Call get for both Things/)
  assert.doesNotMatch(useThingsToolDescription, /Write one concise unified summary/)
})

test('useThings moveSources moves existing sources without deleting the source Thing', async () => {
  const { execute, thingTool } = createThingsTool()
  const schema = (
    thingTool as { inputSchema: { safeParse: (input: unknown) => { success: boolean } } }
  ).inputSchema

  assert.equal(
    schema.safeParse({
      arguments: JSON.stringify({
        action: 'moveSources',
        sourceName: 'source',
        targetName: 'target'
      })
    }).success,
    true
  )
  assert.equal(
    (
      await execute(
        {
          action: 'moveSources',
          sourceName: 'source',
          targetName: 'target',
          threadId: 'thread-1'
        },
        {}
      )
    ).error != null,
    true
  )
  assert.equal(
    schema.safeParse({
      arguments: JSON.stringify({
        action: 'moveSources',
        sourceName: 'source',
        targetName: 'target'
      }),
      threadId: 'thread-1'
    }).success,
    true
  )

  await execute({ action: 'create', name: 'source', summary: 'Source summary' }, {})
  await execute({ action: 'create', name: 'target', summary: 'Target summary' }, {})
  await execute({ action: 'addCurrentThreadSource', name: 'source', preview: 'Source preview' }, {})

  const output = await execute(
    { action: 'moveSources', sourceName: 'source', targetName: 'target' },
    {}
  )

  assert.equal(output.error, undefined)
  assert.match(outputText(output), /Moved sources from #source to #target\./)
  assert.equal((await execute({ action: 'get', name: 'target' }, {})).details != null, true)
  assert.match(outputText(await execute({ action: 'get', name: 'target' }, {})), /Sources: 1/)
  assert.match(outputText(await execute({ action: 'get', name: 'source' }, {})), /#source/)
})

test('useThings delete removes one Thing and rejects extra fields', async () => {
  const { execute, thingTool } = createThingsTool()
  const schema = (
    thingTool as { inputSchema: { safeParse: (input: unknown) => { success: boolean } } }
  ).inputSchema

  assert.equal(
    schema.safeParse({ arguments: JSON.stringify({ action: 'delete', name: 'source' }) }).success,
    true
  )
  assert.equal(
    (await execute({ action: 'delete', name: 'source', targetName: 'target' }, {})).error != null,
    true
  )

  await execute({ action: 'create', name: 'source', summary: 'Source summary' }, {})
  const output = await execute({ action: 'delete', name: 'source' }, {})

  assert.equal(output.error, undefined)
  assert.match(outputText(output), /Deleted #source\./)
  assert.match(outputText(await execute({ action: 'get', name: 'source' }, {})), /Thing not found/)
})

test('useThings supports the full merge primitive workflow', async () => {
  const { execute } = createThingsTool()

  await execute({ action: 'create', name: 'source', summary: 'Source summary' }, {})
  await execute({ action: 'create', name: 'target', summary: 'Target summary' }, {})
  await execute({ action: 'addCurrentThreadSource', name: 'source', preview: 'Source preview' }, {})
  assert.match(outputText(await execute({ action: 'get', name: 'source' }, {})), /Source summary/)
  assert.match(outputText(await execute({ action: 'get', name: 'target' }, {})), /Target summary/)

  await execute({ action: 'updateSummary', name: 'target', summary: 'Unified summary' }, {})
  await execute({ action: 'moveSources', sourceName: 'source', targetName: 'target' }, {})
  await execute({ action: 'delete', name: 'source' }, {})

  const target = outputText(await execute({ action: 'get', name: 'target' }, {}))
  assert.match(target, /Unified summary/)
  assert.match(target, /Sources: 1/)
  assert.match(outputText(await execute({ action: 'get', name: 'source' }, {})), /Thing not found/)
})
