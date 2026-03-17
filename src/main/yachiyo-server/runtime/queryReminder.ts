import { CORE_TOOL_NAMES, type ToolCallName } from '../../../shared/yachiyo/protocol.ts'

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
  const addedTools = CORE_TOOL_NAMES.filter(
    (toolName) => enabledToolSet.has(toolName) && !previousEnabledToolSet.has(toolName)
  )
  const removedTools = CORE_TOOL_NAMES.filter(
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

export function prependQueryReminder(content: string, reminder: string | undefined): string {
  if (!reminder) {
    return content
  }

  return content.trim().length > 0 ? `${reminder}\n\n${content}` : reminder
}

export function prependQueryReminderToLatestUserMessage<
  TMessage extends { role: 'user' | 'assistant'; content: string }
>(messages: TMessage[], reminder: string | undefined): TMessage[] {
  if (!reminder) {
    return messages
  }

  const latestUserMessageIndex = [...messages]
    .map((message, index) => ({ index, role: message.role }))
    .reverse()
    .find((message) => message.role === 'user')?.index

  if (latestUserMessageIndex === undefined) {
    return messages
  }

  return messages.map((message, index) =>
    index === latestUserMessageIndex
      ? {
          ...message,
          content: prependQueryReminder(message.content, reminder)
        }
      : message
  )
}
