import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileAgentLayer,
  compileContextLayers,
  compileHintLayer,
  compileMemoryLayer,
  compilePersonalityLayer
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
})
