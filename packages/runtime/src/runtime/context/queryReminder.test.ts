import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ENABLED_TOOL_NAMES,
  USER_MANAGED_TOOL_NAMES,
  type ToolCallName
} from '@yachiyo/shared/protocol'
import { RUN_MODE_DEFINITIONS, resolveRunModeEnabledTools } from '@yachiyo/shared/toolModes'
import {
  buildCurrentTimeSection,
  buildDisabledToolsReminderSection,
  buildRunModeChangedReminderSection,
  buildToolAvailabilityReminderSection,
  formatDateLine,
  formatQueryReminder
} from './queryReminder.ts'

test('formatQueryReminder wraps multiple sections into one extensible reminder block', () => {
  const reminder = formatQueryReminder([
    {
      key: 'tool-availability',
      title: 'Tool availability changed for this turn',
      lines: ['First reminder line.', 'Second reminder line.']
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
      '- First reminder line.',
      '- Second reminder line.',
      'Additional context:',
      '- Another reminder payload.',
      '</reminder>'
    ].join('\n')
  )
})

function parseToolListLine(line: string, prefix: string): string[] {
  assert.ok(line.startsWith(prefix), `Expected line to start with ${prefix}`)
  const value = line.slice(prefix.length, -1)
  return value === 'none' ? [] : value.split(', ')
}

function assertToolStateLines(input: { lines: string[]; enabledTools: readonly string[] }): void {
  const [enabledLine, disabledLine] = input.lines
  assert.equal(input.lines.length, 2)
  assert.ok(enabledLine)
  assert.ok(disabledLine)

  const effectiveEnabledToolSet = new Set(input.enabledTools)
  assert.deepEqual(parseToolListLine(enabledLine, 'Enabled tools: '), [
    ...new Set(input.enabledTools)
  ])
  assert.deepEqual(
    parseToolListLine(disabledLine, 'Disabled tools: '),
    USER_MANAGED_TOOL_NAMES.filter((toolName) => !effectiveEnabledToolSet.has(toolName))
  )
}

test('buildToolAvailabilityReminderSection emits the complete tool state when it changes', () => {
  const enabledTools: ToolCallName[] = ['querySource', 'updateProfile']
  const previousEnabledTools = resolveRunModeEnabledTools('auto')
  const section = buildToolAvailabilityReminderSection({
    previousEnabledTools,
    enabledTools
  })

  assert.deepEqual(section?.key, 'tool-availability')
  assert.equal(section?.title, 'Tool availability changed for this turn')
  assertToolStateLines({
    lines: section?.lines ?? [],
    enabledTools
  })

  assert.equal(
    buildToolAvailabilityReminderSection({
      previousEnabledTools: enabledTools,
      enabledTools
    }),
    null
  )
})

test('buildRunModeChangedReminderSection emits only when mode changes', () => {
  const runMode = 'explore'
  const enabledTools = ['read', 'grep', 'querySource', 'updateProfile']
  const section = buildRunModeChangedReminderSection({
    previousRunMode: 'auto',
    runMode,
    enabledTools
  })

  assert.equal(section?.key, 'run-mode')
  assert.equal(
    section?.title,
    `Mode changed to ${RUN_MODE_DEFINITIONS[runMode].label} for this turn`
  )
  assert.equal(section?.lines[0], RUN_MODE_DEFINITIONS[runMode].description)
  assertToolStateLines({
    lines: section?.lines.slice(1) ?? [],
    enabledTools
  })

  assert.equal(
    buildRunModeChangedReminderSection({ previousRunMode: runMode, runMode, enabledTools }),
    null
  )
})

test('buildDisabledToolsReminderSection lists tools unavailable in the current mode or context', () => {
  const enabledTools = USER_MANAGED_TOOL_NAMES.slice(0, 3)
  const disabledTools = USER_MANAGED_TOOL_NAMES.slice(3)
  const section = buildDisabledToolsReminderSection({ enabledTools })

  assert.ok(section)
  assert.equal(section.key, 'disabled-tools')
  const linePrefix =
    "The following tools are unavailable in this turn's mode or context and will reject calls: "
  const disabledList = parseToolListLine(
    section.lines[0].replace(linePrefix, 'Disabled tools: '),
    'Disabled tools: '
  )

  assert.deepEqual(disabledList, disabledTools)
  for (const toolName of enabledTools) {
    assert.ok(!disabledList.includes(toolName))
  }
})

test('buildDisabledToolsReminderSection returns null when all default tools are enabled', () => {
  const section = buildDisabledToolsReminderSection({
    enabledTools: [...DEFAULT_ENABLED_TOOL_NAMES]
  })
  assert.equal(section, null)
})

test('buildDisabledToolsReminderSection returns null when all user-managed tools are available', () => {
  const section = buildDisabledToolsReminderSection({
    enabledTools: [...USER_MANAGED_TOOL_NAMES]
  })
  assert.equal(section, null)
})

test('buildDisabledToolsReminderSection uses the supplied available tool names', () => {
  const section = buildDisabledToolsReminderSection({
    enabledTools: [...resolveRunModeEnabledTools('plan'), 'exitPlanMode']
  })
  assert.ok(section)
  assert.doesNotMatch(section.lines.join('\n'), /\bexitPlanMode\b/)
})

test('buildCurrentTimeSection uses local time with day name', () => {
  // Use explicit local components to avoid timezone-dependent assertions
  const date = new Date(2026, 2, 30, 14, 5, 9) // March 30 2026, local
  const section = buildCurrentTimeSection(date)
  assert.equal(section.key, 'current-time')
  assert.match(section.lines[0], /^Date: 2026-03-30 \(\w+\)$/)
  assert.equal(section.lines[1], 'Time: 14:05')
})

test('buildCurrentTimeSection can omit date when includeDate is false', () => {
  const date = new Date(2026, 2, 30, 14, 5, 9)
  const section = buildCurrentTimeSection(date, { includeDate: false })
  assert.equal(section.key, 'current-time')
  assert.equal(section.lines.length, 1)
  assert.equal(section.lines[0], 'Time: 14:05')
})

test('formatDateLine produces YYYY-MM-DD with day name', () => {
  const date = new Date(2026, 2, 30, 14, 5, 9)
  assert.match(formatDateLine(date), /^2026-03-30 \(\w+\)$/)
})
