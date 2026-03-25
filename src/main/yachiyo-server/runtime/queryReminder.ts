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

export function buildCurrentTimeSection(): QueryReminderSection {
  return {
    key: 'current-time',
    title: 'Current local time',
    lines: [new Date().toLocaleString()]
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
