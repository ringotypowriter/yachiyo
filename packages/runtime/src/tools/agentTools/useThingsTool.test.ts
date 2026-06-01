import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { ThingDomain } from '../../app/domain/things/thingDomain.ts'
import { createTool, useThingsToolDescription } from './useThingsTool.ts'

test('useThings tool creates and lists Things', async () => {
  const domain = new ThingDomain({
    storage: createInMemoryYachiyoStorage(),
    now: () => new Date('2026-06-01T00:00:00.000Z')
  })
  const thingTool = createTool({ thingDomain: domain })

  const execute = thingTool.execute as unknown as (
    input: unknown,
    options: unknown
  ) => Promise<{
    error?: string
    details?: unknown
  }>
  await execute(
    { action: 'create', name: 'Raven UI', summary: 'UI work' },
    { toolCallId: 't', messages: [] }
  )
  const output = await execute({ action: 'list' }, { toolCallId: 't', messages: [] })

  assert.equal(output.error, undefined)
  assert.ok(JSON.stringify(output.details).includes('raven-ui'))
})

test('useThings description requires language alignment and no primaryLanguage field', () => {
  assert.match(useThingsToolDescription, /main language/)
  assert.match(
    useThingsToolDescription,
    /Do not create, infer, output, or maintain any primaryLanguage field/
  )
})
