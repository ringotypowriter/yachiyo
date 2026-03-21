import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolAvailabilityReminderSection,
  formatQueryReminder,
  prependQueryReminder,
  prependQueryReminderToLatestUserMessage
} from './queryReminder.ts'

test('formatQueryReminder wraps multiple sections into one extensible reminder block', () => {
  const reminder = formatQueryReminder([
    {
      key: 'tool-availability',
      title: 'Tool availability changed for this turn',
      lines: ['Enabled: bash.', 'Disabled: write, edit.']
    },
    {
      key: 'future-context',
      title: 'Additional context',
      lines: ['Another reminder payload.']
    }
  ])

  assert.equal(
    reminder,
    [
      '<reminder>',
      'Tool availability changed for this turn:',
      '- Enabled: bash.',
      '- Disabled: write, edit.',
      'Additional context:',
      '- Another reminder payload.',
      '</reminder>'
    ].join('\n')
  )
})

test('buildToolAvailabilityReminderSection only emits changed tools', () => {
  assert.deepEqual(
    buildToolAvailabilityReminderSection({
      previousEnabledTools: ['read', 'write', 'edit', 'bash', 'webRead'],
      enabledTools: ['read', 'bash']
    }),
    {
      key: 'tool-availability',
      title: 'Tool availability changed for this turn',
      lines: ['Disabled: write, edit, webRead.']
    }
  )

  assert.equal(
    buildToolAvailabilityReminderSection({
      previousEnabledTools: ['read', 'bash'],
      enabledTools: ['read', 'bash']
    }),
    null
  )
})

test('prependQueryReminderToLatestUserMessage only affects the model-facing latest user query', () => {
  const reminder =
    '<reminder>\nTool availability changed for this turn:\n- Disabled: edit.\n</reminder>'

  assert.deepEqual(
    prependQueryReminderToLatestUserMessage(
      [
        { role: 'user' as const, content: 'First request' },
        { role: 'assistant' as const, content: 'First reply' },
        { role: 'user' as const, content: 'Second request' }
      ],
      reminder
    ),
    [
      { role: 'user', content: 'First request' },
      { role: 'assistant', content: 'First reply' },
      {
        role: 'user',
        content: `${reminder}\n\nSecond request`
      }
    ]
  )

  assert.equal(prependQueryReminder('', reminder), reminder)
})
