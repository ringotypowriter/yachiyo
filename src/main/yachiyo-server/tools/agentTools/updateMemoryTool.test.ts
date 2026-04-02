import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { asSchema, type Tool } from 'ai'

import type { MemoryService } from '../../services/memory/memoryService.ts'
import { createTool } from './updateMemoryTool.ts'

async function readModeEnum(tool: Pick<Tool<unknown, unknown>, 'inputSchema'>): Promise<string[]> {
  const schema = await asSchema(tool.inputSchema).jsonSchema
  const modeSchema = schema.type === 'object' ? schema.properties?.mode : undefined
  assert.ok(modeSchema && typeof modeSchema === 'object' && 'enum' in modeSchema)
  assert.ok(Array.isArray(modeSchema.enum))
  return modeSchema.enum.filter((value): value is string => typeof value === 'string')
}

function createMemoryServiceStub(): MemoryService {
  return {} as MemoryService
}

test('createTool exposes full rewrite mode by default', async () => {
  const tool = createTool({
    memoryService: createMemoryServiceStub(),
    userDocumentPath: '/tmp/USER.md'
  })

  assert.match(tool.description ?? '', /mode "profile":/)
  assert.match(tool.description ?? '', /exact heading name from USER\.md/)
  assert.deepEqual(await readModeEnum(tool), ['profile', 'profile-section', 'memory'])
})

test('createTool removes full rewrite mode from restricted contexts', async () => {
  const tool = createTool({
    memoryService: createMemoryServiceStub(),
    userDocumentPath: '/tmp/USER.md',
    userDocumentMode: 'group',
    rejectFullRewrite: true
  })

  assert.doesNotMatch(tool.description ?? '', /mode "profile":/)
  assert.doesNotMatch(tool.description ?? '', /instead of "profile"/)
  assert.match(tool.description ?? '', /"People", "Group Vibe", or "Topic Hints"/)
  assert.deepEqual(await readModeEnum(tool), ['profile-section', 'memory'])
})

test('createTool repairs a headingless group USER.md before patching a section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-memory-tool-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    await writeFile(userDocumentPath, '# Group\n\nflattened prose only\n', 'utf8')

    const tool = createTool({
      memoryService: createMemoryServiceStub(),
      userDocumentPath,
      userDocumentMode: 'group',
      rejectFullRewrite: true
    })

    const execute = tool.execute as (
      input: { mode: 'profile-section'; section: string; content: string },
      options: object
    ) => Promise<{ content: Array<{ type: 'text'; text: string }>; error?: string }>
    const result = await execute(
      {
        mode: 'profile-section',
        section: 'People',
        content: 'Alice | owner'
      },
      {}
    )

    assert.equal(result.error, undefined)
    assert.match(result.content[0]?.text ?? '', /Section "People" updated\./)

    const repaired = await readFile(userDocumentPath, 'utf8')
    assert.match(repaired, /## People/)
    assert.match(repaired, /## Group Vibe/)
    assert.match(repaired, /## Topic Hints/)
    assert.match(repaired, /Alice \| owner/)
    assert.doesNotMatch(repaired, /flattened prose only/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
