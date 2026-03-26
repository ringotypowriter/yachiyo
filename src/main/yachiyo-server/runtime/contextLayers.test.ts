import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
      '以下是来自 SOUL.md 的自我模型与人格延续记录，请整体吸收并自然融入当前人格：',
      '',
      soulContent
    ].join('\n')
  })
  assert.equal(compileSoulLayer({ content: '   ' }), null)
  assert.equal(compileSoulLayer(undefined), null)
})

test('compileContextLayers preserves user history and orders explicit layers before it', () => {
  const reminder =
    '<reminder>\nTool availability changed for this turn:\n- Disabled: write.\n</reminder>'
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

  assert.deepEqual(compiled, [
    { role: 'system', content: 'Base persona' },
    {
      role: 'system',
      content: [
        '以下是来自 SOUL.md 的自我模型与人格延续记录，请整体吸收并自然融入当前人格：',
        '',
        soulContent
      ].join('\n')
    },
    {
      role: 'system',
      content: [
        '以下是来自 USER.md 的稳定用户理解，请把它当作长期协作画像，而不是当前临时任务状态：',
        '',
        '# USER\n\n## Preferences\n- Prefers direct communication'
      ].join('\n')
    },
    {
      role: 'system',
      content: [
        '以下是当前这次运行里已激活的 Skills。默认只看名称和简介；如果需要详细内容，请使用 skillsRead 按名称读取对应的 SKILL.md：',
        '',
        '- workspace-refactor: Repository-specific refactor workflow'
      ].join('\n')
    },
    { role: 'system', content: 'Workspace: /tmp/thread-1' },
    { role: 'system', content: reminder },
    {
      role: 'system',
      content: ['<memory>', '- Remember the preferred repo root.', '</memory>'].join('\n')
    },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'Latest request' }
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

  // Reasoning parts must be preserved — many models use interleaved thinking
  assert.deepEqual(compiled.slice(2), responseMessages)
  const firstAssistant = compiled[2] as { content: Array<{ type: string }> }
  assert.equal(firstAssistant.content[0].type, 'reasoning')
  const lastAssistant = compiled[4] as { content: Array<{ type: string }> }
  assert.equal(lastAssistant.content[0].type, 'reasoning')
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
