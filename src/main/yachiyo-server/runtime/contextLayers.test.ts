import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileAgentLayer,
  compileContextLayers,
  compileHintLayer,
  compileMemoryLayer,
  compilePersonalityLayer,
  compileSkillsLayer,
  compileUserLayer
} from './contextLayers.ts'

test('compilePersonalityLayer falls back to the base persona when no SOUL traits exist', () => {
  assert.deepEqual(
    compilePersonalityLayer({
      basePersona: 'Base persona'
    }),
    { role: 'system', content: 'Base persona' }
  )
})

test('compileContextLayers preserves user history and orders explicit layers before it', () => {
  const reminder =
    '<reminder>\nTool availability changed for this turn:\n- Disabled: write.\n</reminder>'

  const compiled = compileContextLayers({
    personality: {
      basePersona: 'Base persona',
      evolvedTraits: ['Leans toward concise execution']
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
    {
      role: 'system',
      content: [
        'Base persona',
        '',
        '以下是来自 SOUL 的人格补充，请自然吸收并保持整体稳定：',
        '- Leans toward concise execution'
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
