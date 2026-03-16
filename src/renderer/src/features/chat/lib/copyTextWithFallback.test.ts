import assert from 'node:assert/strict'
import test from 'node:test'

import { copyTextWithFallback } from './copyTextWithFallback.ts'

function createDocumentMock() {
  const operations: string[] = []
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute(_name: string, _value: string) {
      operations.push('readonly')
    },
    select() {
      operations.push('select')
    }
  }

  const document = {
    body: {
      append(node: unknown) {
        operations.push(`append:${node === textarea}`)
      },
      removeChild(node: unknown) {
        operations.push(`remove:${node === textarea}`)
      }
    },
    createElement(tagName: string) {
      operations.push(`create:${tagName}`)
      return textarea
    },
    execCommand(command: string) {
      operations.push(`exec:${command}`)
      return true
    }
  } as unknown as Document

  return { document, operations, textarea }
}

test('copyTextWithFallback falls back to the legacy copy command when clipboard writes are rejected', async () => {
  const { document, operations, textarea } = createDocumentMock()
  const navigator = {
    clipboard: {
      writeText: async (content: string) => {
        assert.equal(content, 'hello')
        throw new Error('Permission denied')
      }
    }
  } as unknown as Navigator

  await copyTextWithFallback('hello', { document, navigator })

  assert.equal(textarea.value, 'hello')
  assert.deepEqual(operations, [
    'create:textarea',
    'readonly',
    'append:true',
    'select',
    'exec:copy',
    'remove:true'
  ])
})

test('copyTextWithFallback prefers the async clipboard API when it succeeds', async () => {
  const { document, operations } = createDocumentMock()
  const writes: string[] = []
  const navigator = {
    clipboard: {
      writeText: async (content: string) => {
        writes.push(content)
      }
    }
  } as unknown as Navigator

  await copyTextWithFallback('world', { document, navigator })

  assert.deepEqual(writes, ['world'])
  assert.deepEqual(operations, [])
})
