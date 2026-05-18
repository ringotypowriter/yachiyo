import type { LanguageModelV3 } from '@ai-sdk/provider'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAnthropicLanguageModel,
  injectUnsignedThinkingIntoAnthropicBody,
  shouldReplayUnsignedAnthropicThinking
} from './anthropic.ts'

test('shouldReplayUnsignedAnthropicThinking enables custom Anthropic-compatible endpoints', () => {
  assert.equal(shouldReplayUnsignedAnthropicThinking('https://api.kimi.com/coding/v1'), true)
  assert.equal(shouldReplayUnsignedAnthropicThinking('https://api.deepseek.com/anthropic'), true)
  assert.equal(shouldReplayUnsignedAnthropicThinking('https://api.anthropic.com/v1'), false)
  assert.equal(shouldReplayUnsignedAnthropicThinking('not-a-url'), false)
})

test('injectUnsignedThinkingIntoAnthropicBody restores unsigned thinking before tool use', () => {
  const body = JSON.stringify({
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'bash',
            input: { command: 'pwd' }
          }
        ]
      }
    ]
  })

  const result = injectUnsignedThinkingIntoAnthropicBody(body, [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should inspect the project.' },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'bash',
          input: { command: 'pwd' }
        }
      ]
    }
  ])

  assert.equal(
    result,
    JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect the project.'
            },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'bash',
              input: { command: 'pwd' }
            }
          ]
        }
      ]
    })
  )
})

test('injectUnsignedThinkingIntoAnthropicBody does not replay signed Anthropic thinking', () => {
  const body = JSON.stringify({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }]
      }
    ]
  })

  assert.equal(
    injectUnsignedThinkingIntoAnthropicBody(body, [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'Claude-native thinking stays private to Claude.',
            providerOptions: { anthropic: { signature: 'real-signature' } }
          },
          { type: 'text', text: 'done' }
        ]
      }
    ]),
    body
  )
})

test('injectUnsignedThinkingIntoAnthropicBody does not replay other-provider reasoning', () => {
  const body = JSON.stringify({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }]
      }
    ]
  })

  assert.equal(
    injectUnsignedThinkingIntoAnthropicBody(body, [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'OpenAI reasoning should not be sent as Anthropic thinking.',
            providerOptions: { openai: { itemId: 'rs_123' } }
          },
          { type: 'text', text: 'done' }
        ]
      }
    ]),
    body
  )
})

test('injectUnsignedThinkingIntoAnthropicBody keeps body alignment after other-provider reasoning', () => {
  const body = JSON.stringify({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }]
      }
    ]
  })

  assert.equal(
    injectUnsignedThinkingIntoAnthropicBody(body, [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'OpenAI reasoning should not consume an Anthropic body part.',
            providerOptions: { openai: { itemId: 'rs_123' } }
          },
          { type: 'reasoning', text: 'Unsigned Anthropic-compatible thinking.' },
          { type: 'text', text: 'done' }
        ]
      }
    ]),
    JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Unsigned Anthropic-compatible thinking.' },
            { type: 'text', text: 'done' }
          ]
        }
      ]
    })
  )
})

test('createAnthropicLanguageModel replays unsigned thinking for custom Anthropic endpoints', async () => {
  let finalBody = ''

  const model = createAnthropicLanguageModel(
    {
      providerName: 'custom-anthropic',
      provider: 'anthropic',
      model: 'custom-unsigned-thinking-model',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/anthropic'
    },
    {
      createAnthropicProvider: (options) =>
        (() =>
          ({
            specificationVersion: 'v3',
            provider: 'anthropic.messages',
            modelId: 'custom-unsigned-thinking-model',
            supportedUrls: {},
            doGenerate: async () => {
              throw new Error('doGenerate should not be used in this test.')
            },
            doStream: async () => {
              await options.fetch?.('https://api.deepseek.com/anthropic/messages', {
                method: 'POST',
                body: JSON.stringify({
                  messages: [
                    {
                      role: 'assistant',
                      content: [
                        {
                          type: 'tool_use',
                          id: 'tool-1',
                          name: 'bash',
                          input: { command: 'pwd' }
                        }
                      ]
                    }
                  ]
                })
              })
              return {} as never
            }
          }) satisfies LanguageModelV3) as never,
      fetchImpl: (async (_input, init) => {
        finalBody = String(init?.body ?? '')
        return new Response('{}')
      }) as typeof globalThis.fetch
    } as never
  ) as LanguageModelV3

  await model.doStream({
    prompt: [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should inspect the project.' },
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'bash',
            input: { command: 'pwd' }
          }
        ]
      }
    ]
  } as never)

  assert.equal(
    finalBody,
    JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect the project.'
            },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'bash',
              input: { command: 'pwd' }
            }
          ]
        }
      ]
    })
  )
})
