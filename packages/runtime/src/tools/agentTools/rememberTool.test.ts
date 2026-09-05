import assert from 'node:assert/strict'
import test from 'node:test'
import { createTool } from './rememberTool.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'

test('remember passes note text, current message and invocation anchor without model rewriting', async () => {
  let captured: unknown[] = []
  const memoryService = {
    validateAndCreateMemory: async (...args: unknown[]) => {
      captured = args
      return { savedCount: 1, id: 'note-id' }
    }
  } as unknown as MemoryService
  const tool = createTool({ memoryService, threadId: 't', messageId: 'm' })
  const result = await tool.execute!(
    { note: 'Our discussion\nwith context.' },
    { toolCallId: 'call', messages: [] }
  )
  assert.equal((captured[0] as { note: string }).note, 'Our discussion\nwith context.')
  assert.deepEqual(captured[2], {
    threadId: 't',
    messageId: 'm',
    toolCallId: 'call',
    workspacePath: undefined
  })
  assert.ok(JSON.stringify(result).includes('note-id'))
})

test('remember rejects nonexistent sources and reports deletion as success', async () => {
  let writes = 0
  const memoryService = {
    validateAndCreateMemory: async () => {
      writes++
      return { savedCount: 0, id: 'note-id', deleted: true }
    }
  } as unknown as MemoryService
  const tool = createTool({ memoryService, storage: createInMemoryYachiyoStorage() })
  const bad = await tool.execute!(
    { note: 'A claim', sources: ['thread_message:missing:m'] },
    { toolCallId: 'c', messages: [] }
  )
  assert.ok((bad as { error?: string }).error)
  assert.equal(writes, 0)
  const removed = await tool.execute!(
    { id: 'note-id', action: 'delete' },
    { toolCallId: 'c', messages: [] }
  )
  assert.equal((removed as { error?: string }).error, undefined)
})
