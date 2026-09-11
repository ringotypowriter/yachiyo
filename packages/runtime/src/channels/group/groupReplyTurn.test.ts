import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
import { extractFinalGroupReply, runGroupReplyTurn } from './groupReplyTurn.ts'

const success = (
  responseMessages: unknown[],
  finishReason = 'stop'
): AuxiliaryTextGenerationResult => ({
  status: 'success',
  settings: { providerName: 'test', provider: 'openai', model: 'test', apiKey: '', baseUrl: '' },
  text: 'private commentary followed by answer',
  usage: {
    promptTokens: 1,
    completionTokens: 1,
    totalPromptTokens: 1,
    totalCompletionTokens: 1,
    finishReason,
    responseMessages
  }
})
const final = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'private' },
    { type: 'text', text: 'answer' }
  ]
}

test('extracts only final assistant text after research, not accumulated commentary or reasoning', () => {
  assert.equal(
    extractFinalGroupReply(
      success([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking it up' },
            { type: 'tool-call', toolName: 'web_search' }
          ]
        },
        { role: 'tool', content: [] },
        final
      ])
    ),
    'answer'
  )
})
for (const reason of ['length', 'tool-calls', 'content-filter', 'error', 'unknown']) {
  test(`does not publish output ending with ${reason}`, () => {
    assert.equal(extractFinalGroupReply(success([final], reason)), null)
  })
}
test('does not fall back to accumulated text without a final assistant message', () => {
  assert.equal(extractFinalGroupReply(success([])), null)
  assert.equal(extractFinalGroupReply(success([final, { role: 'tool', content: [] }])), null)
  assert.equal(
    extractFinalGroupReply(
      success([
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'commentary' }, { type: 'tool-call' }]
        }
      ])
    ),
    null
  )
  assert.equal(extractFinalGroupReply({ status: 'unavailable', reason: 'not-configured' }), null)
})
test('explicit silence suppresses even a later final answer', async () => {
  const sent: string[] = []
  const outcome = await runGroupReplyTurn({
    messages: [],
    generate: async (_messages, staySilent) => {
      staySilent()
      return { result: success([final]), reply: 'answer' }
    },
    send: async (text) => {
      sent.push(text)
      return { sentText: text }
    }
  })
  assert.deepEqual(sent, [])
  assert.equal(outcome.sentText, undefined)
})
test('sends once and records the actual rewritten text', async () => {
  const sent: string[] = []
  const outcome = await runGroupReplyTurn({
    messages: [],
    generate: async () => ({ result: success([final]), reply: 'answer' }),
    send: async (text) => {
      sent.push(text)
      return { sentText: 'rewritten' }
    }
  })
  assert.deepEqual(sent, ['answer'])
  assert.equal(outcome.sentText, 'rewritten')
})
test('allows one correction only after an explicit retryable rejection', async () => {
  let generations = 0
  const outcome = await runGroupReplyTurn({
    messages: [{ role: 'user', content: 'question' }],
    generate: async (messages) => {
      if (generations++)
        assert.deepEqual(messages.slice(-2), [
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'Shorten to 10 characters.' }
        ])
      return { result: success([final]), reply: 'answer' }
    },
    send: async () => ({ retry: 'Shorten to 10 characters.' })
  })
  assert.equal(generations, 2)
  assert.equal(outcome.sentText, undefined)
})
test('does not retry an ambiguous delivery failure', async () => {
  let generations = 0
  await runGroupReplyTurn({
    messages: [],
    generate: async () => {
      generations++
      return { result: success([final]), reply: 'answer' }
    },
    send: async () => ({})
  })
  assert.equal(generations, 1)
})
test('empty replies and failed generations cannot send even if a draft exists', async () => {
  for (const generation of [
    { result: success([final]), reply: '   ' },
    {
      result: { status: 'unavailable', reason: 'not-configured' } as AuxiliaryTextGenerationResult,
      reply: 'draft'
    }
  ]) {
    await runGroupReplyTurn({
      messages: [],
      generate: async () => generation,
      send: async () => {
        assert.fail('must not send')
      }
    })
  }
})

test('correction preserves total usage, initial context size, and the rejected generation trace', async () => {
  let calls = 0
  const outcome = await runGroupReplyTurn({
    messages: [],
    generate: async () => {
      const result = success([final])
      assert.equal(result.status, 'success')
      result.usage = {
        ...result.usage!,
        initialPromptTokens: ++calls * 10,
        modelGenerationDurationMs: 20,
        cacheReadTokens: 3
      }
      return { result, reply: 'answer' }
    },
    send: async () => (calls === 1 ? { retry: 'Shorten.' } : { sentText: 'answer' })
  })
  assert.equal(outcome.result.status, 'success')
  assert.equal(outcome.result.usage?.initialPromptTokens, 10)
  assert.equal(outcome.result.usage?.totalPromptTokens, 2)
  assert.equal(outcome.result.usage?.totalCompletionTokens, 2)
  assert.equal(outcome.result.usage?.modelGenerationDurationMs, 40)
  assert.equal(outcome.result.usage?.cacheReadTokens, 6)
  assert.deepEqual(outcome.result.responseMessages, [
    final,
    { role: 'user', content: 'Shorten.' },
    final
  ])
})

test('failed correction keeps the first successful generation available for accounting without sending', async () => {
  let calls = 0
  const first = success([final])
  const outcome = await runGroupReplyTurn({
    messages: [],
    generate: async () =>
      ++calls === 1
        ? { result: first, reply: 'answer' }
        : { result: { status: 'unavailable', reason: 'not-configured' }, reply: null },
    send: async () => ({ retry: 'Shorten.' })
  })
  assert.equal(outcome.result.status, 'unavailable')
  assert.equal(outcome.previousResult, first)
  assert.equal(outcome.sentText, undefined)
})
