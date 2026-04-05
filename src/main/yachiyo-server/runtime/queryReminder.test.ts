import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCurrentTimeSection,
  buildDisabledToolsReminderSection,
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

test('buildDisabledToolsReminderSection lists disabled user-managed tools', () => {
  const section = buildDisabledToolsReminderSection({
    enabledTools: ['read', 'bash', 'grep']
  })
  assert.ok(section)
  assert.equal(section.key, 'disabled-tools')
  assert.ok(section.lines[0].includes('write'))
  assert.ok(section.lines[0].includes('edit'))
  assert.ok(section.lines[0].includes('glob'))
  assert.ok(section.lines[0].includes('webRead'))
  assert.ok(section.lines[0].includes('webSearch'))
  // Should not mention enabled tools
  assert.ok(!section.lines[0].includes('read,'))
  assert.ok(!section.lines[0].includes('bash'))
  assert.ok(!section.lines[0].includes('grep'))
})

test('buildDisabledToolsReminderSection returns null when all tools enabled', () => {
  const section = buildDisabledToolsReminderSection({
    enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch']
  })
  assert.equal(section, null)
})

test('buildDisabledToolsReminderSection excludes runtime-managed tools', () => {
  // Even if skillsRead is not in enabledTools, it should not appear (it's runtime-managed)
  const section = buildDisabledToolsReminderSection({
    enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch']
  })
  assert.equal(section, null)
})

test('buildCurrentTimeSection uses local time with day name', () => {
  // Use explicit local components to avoid timezone-dependent assertions
  const date = new Date(2026, 2, 30, 14, 5, 9) // March 30 2026, local
  const section = buildCurrentTimeSection(date)
  assert.equal(section.key, 'current-time')
  assert.equal(section.title, 'Current date and time (local)')
  assert.match(section.lines[0], /^Date: 2026-03-30 \(\w+\)$/)
  assert.equal(section.lines[1], 'Time: 14:05:09')
})
