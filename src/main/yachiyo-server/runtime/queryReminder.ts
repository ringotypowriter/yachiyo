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

export function buildCurrentTimeSection(now: Date = new Date()): QueryReminderSection {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const dayName = DAY_NAMES[now.getDay()]
  return {
    key: 'current-time',
    title: 'Current date and time (local)',
    lines: [`Date: ${year}-${month}-${day} (${dayName})`, `Time: ${hours}:${minutes}:${seconds}`]
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
