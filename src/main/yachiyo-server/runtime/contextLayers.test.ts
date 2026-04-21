import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendTurnContextToUserMessage,
  compileAgentLayer,
  compileContextLayers,
  compileHintLayer,
  compileMemoryLayer,
  compilePersonalityLayer,
  compileSoulLayer,
  compileSkillsLayer,
  compileUserLayer
} from './contextLayers.ts'

test('compilePersonalityLayer returns the base persona', () => {
  assert.deepEqual(compilePersonalityLayer({ basePersona: 'Base persona' }), {
    role: 'system',
    content: 'Base persona'
  })
})

test('compileSoulLayer wraps raw SOUL.md content', () => {
  const soulContent =
    '# SOUL\n\n## Evolved Traits\n### 2026-03-25\n- Leans toward concise execution'
  assert.deepEqual(compileSoulLayer({ content: soulContent }), {
    role: 'system',
    content: [
      'The following is your self-model and personality continuity record from SOUL.md. Absorb it holistically and integrate it naturally into your current persona:',
      '',
      soulContent
    ].join('\n')
  })
  assert.equal(compileSoulLayer({ content: '   ' }), null)
  assert.equal(compileSoulLayer(undefined), null)
})

test('compileContextLayers merges turn context into the last user message', () => {
  const reminder =
    '<reminder>\nTool availability changed for this turn:\n- Disabled: write.\n</reminder>'
  const memoryBlock = [
    '<memory>',
    "Background context from past conversations. Focus on the user's query first;",
    'overlapping terms do not make an entry relevant — judge by actual applicability.',
    '- Remember the preferred repo root.',
    '</memory>'
  ].join('\n')
  const soulContent =
    '# SOUL\n\n## Evolved Traits\n### 2026-03-25\n- Leans toward concise execution'

  const compiled = compileContextLayers({
    personality: {
      basePersona: 'Base persona'
    },
    soul: {
      content: soulContent
    },
    user: {
      content: '# USER\n\n## Preferences\n- Prefers direct communication'
    },
    skills: {
      activeSkills: [
        {
          name: 'workspace-refactor',
          description: 'Repository-specific refactor workflow'
        }
      ]
    },
    agent: {
      instructions: 'Workspace: /tmp/thread-1'
    },
    hint: {
      reminder
    },
    memory: {
      entries: ['Remember the preferred repo root.']
    },
    history: [
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Latest request' }
    ]
  })

  const soulPreamble =
    'The following is your self-model and personality continuity record from SOUL.md. Absorb it holistically and integrate it naturally into your current persona:'
  const userPreamble =
    'The following is your durable understanding of the user from USER.md. Treat it as a long-term collaboration profile, not as current task state:'
  const skillsPreamble =
    'The following Skills are active for this run. You see names and descriptions only. To use a skill, first call skillsRead to get its exact SKILL.md path, then use the read tool on that exact path. Read SKILL.md before using the skill. If SKILL.md references other files and your work needs them, read those as well:'

  assert.deepEqual(compiled, [
    // Consolidated system message (stable prefix for prompt caching)
    {
      role: 'system',
      content: [
        'Base persona',
        [soulPreamble, '', soulContent].join('\n'),
        [userPreamble, '', '# USER\n\n## Preferences\n- Prefers direct communication'].join('\n'),
        [skillsPreamble, '', '- workspace-refactor: Repository-specific refactor workflow'].join(
          '\n'
        ),
        'Workspace: /tmp/thread-1'
      ].join('\n\n')
    },
    // Prior history
    { role: 'assistant', content: 'Previous answer' },
    // User query with turn context merged in
    {
      role: 'user',
      content: ['Latest request', reminder, memoryBlock].join('\n\n')
    }
  ])
})

test('individual layer compilers drop empty content', () => {
  assert.equal(compileAgentLayer({ instructions: '   ' }), null)
  assert.equal(compileHintLayer({ reminder: '   ' }), null)
  assert.equal(compileMemoryLayer({ entries: [] }), null)
  assert.equal(compileSkillsLayer({ activeSkills: [] }), null)
  assert.equal(compileUserLayer({ content: '   ' }), null)
})

test('assistant message with responseMessages injects structured tool history', () => {
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that file.' },
        {
          type: 'tool-call',
          toolCallId: 'tc-1',
          toolName: 'read',
          input: { path: '/tmp/foo.ts' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'read',
          output: { type: 'text', value: 'file contents here' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The file contains...' }]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'You are helpful.' },
    history: [
      { role: 'user', content: 'Read foo.ts' },
      { role: 'assistant', content: 'The file contains...', responseMessages },
      { role: 'user', content: 'Now edit it' }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Read foo.ts' },
    ...responseMessages,
    { role: 'user', content: 'Now edit it' }
  ])
})

test('assistant message without responseMessages falls back to plain text', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'You are helpful.' },
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'Bye' }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'Bye' }
  ])
})

test('mixed history with tool and non-tool assistant messages preserves interleaving', () => {
  const toolResponseMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'tc-a', toolName: 'bash', input: { command: 'ls' } }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-a',
          toolName: 'bash',
          output: { type: 'text', value: 'file1.ts\nfile2.ts' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Found two files.' }]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'List files' },
      { role: 'assistant', content: 'Found two files.', responseMessages: toolResponseMessages },
      { role: 'user', content: 'What do they contain?' },
      { role: 'assistant', content: 'They contain code.' },
      { role: 'user', content: 'Thanks' }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    { role: 'user', content: 'List files' },
    ...toolResponseMessages,
    { role: 'user', content: 'What do they contain?' },
    { role: 'assistant', content: 'They contain code.' },
    { role: 'user', content: 'Thanks' }
  ])
})

test('multi-step tool calls preserve exact order in responseMessages', () => {
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Step 1' },
        {
          type: 'tool-call',
          toolCallId: 'tc-1',
          toolName: 'read',
          input: { path: '/a.ts' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'read',
          output: { type: 'text', value: 'content A' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Step 2' },
        {
          type: 'tool-call',
          toolCallId: 'tc-2',
          toolName: 'edit',
          input: { path: '/a.ts', content: 'new' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-2',
          toolName: 'edit',
          output: { type: 'text', value: 'edited' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done editing.' }]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Edit file' },
      { role: 'assistant', content: 'Done editing.', responseMessages }
    ]
  })

  // System prompt + user message + 5 response messages = 7 total
  assert.equal(compiled.length, 7)
  assert.deepEqual(compiled[0], { role: 'system', content: 'Base' })
  assert.deepEqual(compiled[1], { role: 'user', content: 'Edit file' })
  // The 5 response messages are injected in exact original order
  assert.deepEqual(compiled.slice(2), responseMessages)
})

test('responseMessages with interleaved reasoning are preserved in replay', () => {
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'The user wants me to read a file, let me check...' },
        { type: 'text', text: 'Reading the file now.' },
        {
          type: 'tool-call',
          toolCallId: 'tc-r1',
          toolName: 'read',
          input: { path: '/src/index.ts' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-r1',
          toolName: 'read',
          output: { type: 'text', value: 'export const main = () => {}' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'OK, it exports a main function. Let me explain.' },
        { type: 'text', text: 'The file exports a main function.' }
      ]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Show me index.ts' },
      {
        role: 'assistant',
        content: 'The file exports a main function.',
        responseMessages
      }
    ]
  })

  // Reasoning parts must be preserved — many models use interleaved thinking.
  // Reasoning blocks without Anthropic signatures get a synthetic passthrough
  // signature so the adapter doesn't drop them.
  const firstAssistant = compiled[2] as { content: Array<{ type: string }> }
  assert.equal(firstAssistant.content[0].type, 'reasoning')
  assert.equal(firstAssistant.content.length, 3)
  const lastAssistant = compiled[4] as { content: Array<{ type: string }> }
  assert.equal(lastAssistant.content[0].type, 'reasoning')
  assert.equal(lastAssistant.content.length, 2)
  // Tool message is unchanged
  assert.deepEqual(compiled[3], responseMessages[1])
})

test('responseMessages with OpenAI-native reasoning are not patched with Anthropic signature', () => {
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'OpenAI encrypted reasoning',
          providerOptions: { openai: { itemId: 'item_123' } }
        },
        { type: 'text', text: 'Here is the answer.' }
      ]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Here is the answer.', responseMessages }
    ]
  })

  const assistant = compiled[2] as {
    content: Array<{ type: string; providerOptions?: Record<string, unknown> }>
  }
  assert.equal(assistant.content[0].type, 'reasoning')
  const openaiMeta = (
    (assistant.content[0].providerOptions as Record<string, unknown> | undefined)?.openai as
      | Record<string, unknown>
      | undefined
  )?.itemId
  assert.equal(openaiMeta, 'item_123')
  assert.equal(
    (assistant.content[0].providerOptions as Record<string, unknown> | undefined)?.anthropic,
    undefined,
    'should not inject synthetic anthropic signature into OpenAI-native reasoning'
  )
})

test('responseMessages with signature only in providerMetadata copies it to providerOptions', () => {
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Real Anthropic thinking',
          providerMetadata: { anthropic: { signature: 'real-sig-abc' } }
        },
        { type: 'text', text: 'Here is the answer.' }
      ]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Here is the answer.', responseMessages }
    ]
  })

  const assistant = compiled[2] as {
    content: Array<{ type: string; providerOptions?: Record<string, unknown> }>
  }
  assert.equal(assistant.content[0].type, 'reasoning')
  const copiedSig = (
    (assistant.content[0].providerOptions as Record<string, unknown> | undefined)?.anthropic as
      | Record<string, unknown>
      | undefined
  )?.signature
  assert.equal(
    copiedSig,
    'real-sig-abc',
    'should copy signature from providerMetadata into providerOptions'
  )
})

test('empty responseMessages array falls back to plain text', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!', responseMessages: [] }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' }
  ])
})

test('turn context is merged into current query after tool-history replay', () => {
  const toolResponseMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'tc-x', toolName: 'read', input: { path: '/f.ts' } }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-x',
          toolName: 'read',
          output: { type: 'text', value: 'code' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }]
    }
  ]

  const memoryBlock = [
    '<memory>',
    "Background context from past conversations. Focus on the user's query first;",
    'overlapping terms do not make an entry relevant — judge by actual applicability.',
    '- user likes tests',
    '</memory>'
  ].join('\n')

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    hint: { reminder: '<reminder>write disabled</reminder>' },
    memory: { entries: ['user likes tests'] },
    history: [
      { role: 'user', content: 'Read f.ts' },
      { role: 'assistant', content: 'Done.', responseMessages: toolResponseMessages },
      { role: 'user', content: 'Now edit it' }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    // Prior history with structured tool replay
    { role: 'user', content: 'Read f.ts' },
    ...toolResponseMessages,
    // Current user query with turn context merged in
    {
      role: 'user',
      content: ['Now edit it', '<reminder>write disabled</reminder>', memoryBlock].join('\n\n')
    }
  ])
})

test('turn context without history goes at the end', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    hint: { reminder: 'tools reminder' },
    history: []
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    { role: 'user', content: 'tools reminder' }
  ])
})

test('no turn context leaves system layers and history unchanged', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Bye' }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Bye' }
  ])
})

test('first message in thread: turn context is merged into the only user message', () => {
  const memoryBlock = [
    '<memory>',
    "Background context from past conversations. Focus on the user's query first;",
    'overlapping terms do not make an entry relevant — judge by actual applicability.',
    '- mem1',
    '</memory>'
  ].join('\n')

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    hint: { reminder: 'reminder' },
    memory: { entries: ['mem1'] },
    history: [{ role: 'user', content: 'First message' }]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    {
      role: 'user',
      content: ['First message', 'reminder', memoryBlock].join('\n\n')
    }
  ])
})

test('image-data blocks are stripped from tool result responseMessages during history replay', () => {
  const base64Data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc-img',
          toolName: 'read',
          input: { path: '/tmp/photo.png' }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-img',
          toolName: 'read',
          output: {
            type: 'content',
            value: [
              { type: 'image-data', data: base64Data, mediaType: 'image/png' },
              { type: 'text', text: 'Read image photo.png (image/png, 67 bytes)' }
            ]
          }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The image shows...' }]
    }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'You are helpful.' },
    history: [
      { role: 'user', content: 'Read photo.png' },
      { role: 'assistant', content: 'The image shows...', responseMessages },
      { role: 'user', content: 'Describe it more' }
    ]
  })

  const toolMsg = compiled.find((m) => m.role === 'tool') as
    | { role: string; content: Array<{ type: string; output?: unknown }> }
    | undefined
  assert.ok(toolMsg, 'tool message should be present')

  const toolResult = toolMsg?.content[0]
  assert.equal(toolResult?.type, 'tool-result')

  const output = toolResult?.output as {
    type: string
    value: Array<{ type: string; text?: string }>
  }
  assert.equal(output.type, 'content')
  assert.ok(
    !output.value.some((b) => b.type === 'image-data'),
    'image-data block should be replaced'
  )
  const textBlocks = output.value.filter((b) => b.type === 'text')
  assert.ok(textBlocks.length >= 2, 'should have both the placeholder and the original summary')
  assert.ok(
    textBlocks.some((b) => b.text?.includes('not re-sent')),
    'placeholder should explain the image is omitted'
  )
  assert.ok(
    textBlocks.some((b) => b.text?.includes('Read image')),
    'original summary text should remain'
  )
})

test('tool results without image-data pass through history replay unchanged', () => {
  const responseMessages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'read', input: { path: '/tmp/foo.ts' } }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'read',
          output: { type: 'content', value: [{ type: 'text', text: 'const x = 1' }] }
        }
      ]
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  ]

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    history: [
      { role: 'user', content: 'Read foo.ts' },
      { role: 'assistant', content: 'Done.', responseMessages },
      { role: 'user', content: 'Thanks' }
    ]
  })

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base' },
    { role: 'user', content: 'Read foo.ts' },
    ...responseMessages,
    { role: 'user', content: 'Thanks' }
  ])
})

test('anthropic cache breakpoints mark system and pre-last-user messages', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    anthropicCacheBreakpoints: true,
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Bye' }
    ]
  })

  // BP1: system message
  const system = compiled[0]
  assert.equal(system.role, 'system')
  assert.deepEqual((system.providerOptions as Record<string, unknown>)?.anthropic, {
    cacheControl: { type: 'ephemeral' }
  })

  // BP2: message before last user ("Hi" assistant)
  const preLast = compiled[2]
  assert.equal(preLast.role, 'assistant')
  assert.equal(preLast.content, 'Hi')
  assert.deepEqual((preLast.providerOptions as Record<string, unknown>)?.anthropic, {
    cacheControl: { type: 'ephemeral' }
  })

  // Last user message has no breakpoint
  const lastUser = compiled[3]
  assert.equal(lastUser.role, 'user')
  assert.equal(lastUser.providerOptions, undefined)
})

test('anthropic cache breakpoints merge with existing providerOptions', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    anthropicCacheBreakpoints: true,
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Follow up' }
    ]
  })

  // System message should have merged providerOptions
  const system = compiled[0]
  const opts = system.providerOptions as Record<string, unknown>
  assert.ok(opts?.anthropic, 'anthropic key should exist')
  assert.deepEqual((opts.anthropic as Record<string, unknown>).cacheControl, {
    type: 'ephemeral'
  })
})

test('anthropic cache breakpoints add midpoint for long conversations', () => {
  // Build a conversation with 14 messages between system and BP2 position
  // (7 user-assistant pairs = 14 messages, exceeding MIDPOINT_BREAKPOINT_MIN_GAP of 12)
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (let i = 0; i < 8; i++) {
    history.push({ role: 'user', content: `User ${i}` })
    history.push({ role: 'assistant', content: `Reply ${i}` })
  }
  // Final user message (the volatile one)
  history.push({ role: 'user', content: 'Latest' })

  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    anthropicCacheBreakpoints: true,
    history
  })

  // Count messages with cache breakpoints
  const breakpointMessages = compiled.filter(
    (m) => (m.providerOptions as Record<string, unknown> | undefined)?.anthropic
  )

  // Should have 3 breakpoints: system, midpoint, pre-last-user
  assert.equal(
    breakpointMessages.length,
    3,
    'should have 3 cache breakpoints for long conversation'
  )

  // Midpoint should be an assistant message
  const midBp = breakpointMessages[1]
  assert.equal(midBp.role, 'assistant', 'midpoint breakpoint should be on an assistant message')

  // Last user message should NOT have a breakpoint
  const lastMsg = compiled[compiled.length - 1]
  assert.equal(lastMsg.role, 'user')
  assert.equal(lastMsg.providerOptions, undefined)
})

test('anthropic cache breakpoints skip midpoint for short conversations', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Base' },
    anthropicCacheBreakpoints: true,
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Bye' }
    ]
  })

  const breakpointMessages = compiled.filter(
    (m) => (m.providerOptions as Record<string, unknown> | undefined)?.anthropic
  )

  // Only 2 breakpoints: system + pre-last-user
  assert.equal(breakpointMessages.length, 2, 'short conversation should have only 2 breakpoints')
})

test('system layers are consolidated into a single system message', () => {
  const compiled = compileContextLayers({
    personality: { basePersona: 'Personality' },
    soul: { content: 'Soul content' },
    agent: { instructions: 'Agent instructions' },
    history: [{ role: 'user', content: 'Hello' }]
  })

  const systemMessages = compiled.filter((m) => m.role === 'system')
  assert.equal(systemMessages.length, 1, 'should have exactly one consolidated system message')
  const content = systemMessages[0].content as string
  assert.ok(content.includes('Personality'), 'should include personality')
  assert.ok(content.includes('Soul content'), 'should include soul')
  assert.ok(content.includes('Agent instructions'), 'should include agent')
})

test('appendTurnContextToUserMessage handles string content', () => {
  const result = appendTurnContextToUserMessage({ role: 'user', content: 'Hello' }, [
    '<reminder>time</reminder>'
  ])
  assert.deepEqual(result, {
    role: 'user',
    content: 'Hello\n\n<reminder>time</reminder>'
  })
})

test('appendTurnContextToUserMessage preserves multimodal array content', () => {
  const imagePart = {
    type: 'image' as const,
    image: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png'
  }
  const textPart = { type: 'text' as const, text: 'Describe this image' }
  const result = appendTurnContextToUserMessage(
    { role: 'user', content: [textPart, imagePart] } as never,
    ['<reminder>time</reminder>', '<memory>\n- mem1\n</memory>']
  )

  assert.equal(result.role, 'user')
  const content = result.content as Array<{ type: string; text?: string }>
  // Original parts preserved
  assert.deepEqual(content[0], textPart)
  assert.deepEqual(content[1], imagePart)
  // Turn context appended as text parts
  assert.equal(content[2].type, 'text')
  assert.equal(content[2].text, '<reminder>time</reminder>')
  assert.equal(content[3].type, 'text')
  assert.ok(content[3].text?.includes('mem1'))
})
