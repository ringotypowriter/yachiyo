import { USER_MANAGED_TOOL_NAMES, type ToolCallName } from '../../../shared/yachiyo/protocol.ts'

export interface QueryReminderSection {
  key: string
  title: string
  lines: string[]
}

export function buildToolAvailabilityReminderSection(input: {
  previousEnabledTools: ToolCallName[]
  enabledTools: ToolCallName[]
}): QueryReminderSection | null {
  const previousEnabledToolSet = new Set(input.previousEnabledTools)
  const enabledToolSet = new Set(input.enabledTools)
  const addedTools = USER_MANAGED_TOOL_NAMES.filter(
    (toolName) => enabledToolSet.has(toolName) && !previousEnabledToolSet.has(toolName)
  )
  const removedTools = USER_MANAGED_TOOL_NAMES.filter(
    (toolName) => !enabledToolSet.has(toolName) && previousEnabledToolSet.has(toolName)
  )

  if (addedTools.length === 0 && removedTools.length === 0) {
    return null
  }

  return {
    key: 'tool-availability',
    title: 'Tool availability changed for this turn',
    lines: [
      ...(addedTools.length > 0 ? [`Enabled: ${addedTools.join(', ')}.`] : []),
      ...(removedTools.length > 0 ? [`Disabled: ${removedTools.join(', ')}.`] : [])
    ]
  }
}

export function buildDisabledToolsReminderSection(input: {
  enabledTools: ToolCallName[]
}): QueryReminderSection | null {
  const enabledToolSet = new Set(input.enabledTools)
  const disabledTools = USER_MANAGED_TOOL_NAMES.filter((toolName) => !enabledToolSet.has(toolName))

  if (disabledTools.length === 0) {
    return null
  }

  return {
    key: 'disabled-tools',
    title: 'Disabled tools',
    lines: [
      `The following tools are disabled by the user and will reject calls: ${disabledTools.join(', ')}.`,
      'Do not attempt to use them unless the user re-enables them.'
    ]
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function formatDateLine(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d} (${DAY_NAMES[now.getDay()]})`
}

export function buildCurrentTimeSection(
  now: Date = new Date(),
  { includeDate = true }: { includeDate?: boolean } = {}
): QueryReminderSection {
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const lines = includeDate
    ? [`Date: ${formatDateLine(now)}`, `Time: ${hours}:${minutes}`]
    : [`Time: ${hours}:${minutes}`]
  return {
    key: 'current-time',
    title: includeDate ? 'Current date and time (local)' : 'Current time (local)',
    lines
  }
}

/**
 * Reminder injected when the user sends a mid-run steer message.
 * Tells the model how to handle the steer without derailing in-progress work.
 */
export function buildSteerReminderSection(): QueryReminderSection {
  return {
    key: 'steer-guidance',
    title: 'Mid-run steer from the user',
    lines: [
      'This message arrived while you were already working. It is a steer, not a fresh request.',
      'If the steer adjusts your current work: incorporate the adjustment and continue to completion. Do not abandon in-progress work.',
      'If the steer asks you to stop: stop immediately, summarize what you have completed so far, and ask the user what they need.',
      'If the steer is a follow-up question: finish your current work first, then summarize what you did, and finally answer the question.'
    ]
  }
}

export function formatQueryReminder(sections: QueryReminderSection[]): string | undefined {
  const normalizedSections = sections
    .map((section) => ({
      ...section,
      lines: section.lines.map((line) => line.trim()).filter(Boolean),
      title: section.title.trim()
    }))
    .filter((section) => section.title && section.lines.length > 0)

  if (normalizedSections.length === 0) {
    return undefined
  }

  const lines = ['<reminder>']

  for (const section of normalizedSections) {
    lines.push(`${section.title}:`)
    lines.push(...section.lines.map((line) => `- ${line}`))
  }

  lines.push('</reminder>')

  return lines.join('\n')
}
