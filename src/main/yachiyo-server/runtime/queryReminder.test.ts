import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCurrentTimeSection,
  buildToolAvailabilityReminderSection,
  formatQueryReminder
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

test('buildCurrentTimeSection includes an explicit date line', () => {
  assert.deepEqual(buildCurrentTimeSection(new Date('2026-03-30T12:34:56.000Z')), {
    key: 'current-time',
    title: 'Current date and time',
    lines: ['Date: 2026-03-30', 'Time: 12:34:56 UTC']
  })
})
