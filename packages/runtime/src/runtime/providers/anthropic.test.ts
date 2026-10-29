import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import {
  createAnthropicLanguageModel,
  injectUnsignedThinkingIntoAnthropicBody,
  shouldReplayUnsignedAnthropicThinking
} from './anthropic.ts'
import { resolveAiSdkRuntimeDependencies } from './dependencies.ts'
import { createProviderOptions } from './providerOptions.ts'

for (const streaming of [false, true]) {
  test(`Fable 5.1 ${streaming ? 'streaming' : 'generation'} requests use adaptive thinking and effort`, async () => {
    const settings: ProviderSettings = {
      providerName: 'anthropic',
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      thinkingEnabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com/v1'
    }
    let body:
      | { thinking?: unknown; output_config?: { effort?: string }; max_tokens?: number }
      | undefined
    const model = createAnthropicLanguageModel(
      settings,
      resolveAiSdkRuntimeDependencies({
        createAnthropicProvider: (options) =>
          createAnthropic({
            ...options,
            fetch: async (_input, init) => {
              body = JSON.parse(String(init?.body))
              if (streaming) {
                return new Response('', { headers: { 'content-type': 'text/event-stream' } })
              }
              return Response.json({
                id: 'msg-test',
                type: 'message',
                role: 'assistant',
                model: settings.model,
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 }
              })
            }
          })
      })
    ) as LanguageModelV4

    const options = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      maxOutputTokens: 1024,
      providerOptions: createProviderOptions(settings, 'default', 'high')
    }
    if (streaming) {
      const result = await model.doStream(options)
      await result.stream.cancel()
    } else {
      await model.doGenerate(options)
    }

    assert.deepEqual(body?.thinking, { type: 'adaptive' })
    assert.equal(body?.output_config?.effort, 'high')
    assert.equal(body?.max_tokens, 1024)
  })
}

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
      createAnthropicProvider: (options: { fetch?: typeof globalThis.fetch }) =>
        (() =>
          ({
            specificationVersion: 'v4',
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
          }) satisfies LanguageModelV4) as never,
      fetchImpl: (async (_input, init) => {
        finalBody = String(init?.body ?? '')
        return new Response('{}')
      }) as typeof globalThis.fetch
    } as never
  ) as LanguageModelV4

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
