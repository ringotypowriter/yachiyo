import { USER_MANAGED_TOOL_NAMES, type RunModeId } from '@yachiyo/shared/protocol'
import { RUN_MODE_DEFINITIONS } from '@yachiyo/shared/toolModes'

export interface QueryReminderSection {
  key: string
  title: string
  lines: string[]
}

function formatToolList(toolNames: readonly string[]): string {
  return toolNames.length > 0 ? toolNames.join(', ') : 'none'
}

function buildToolStateLines(input: { enabledTools: readonly string[] }): string[] {
  const enabledTools = [...new Set(input.enabledTools)]
  const enabledToolSet = new Set(enabledTools)
  const disabledTools = USER_MANAGED_TOOL_NAMES.filter((toolName) => !enabledToolSet.has(toolName))
  return [
    `Enabled tools: ${formatToolList(enabledTools)}.`,
    `Disabled tools: ${formatToolList(disabledTools)}.`
  ]
}

export function buildToolAvailabilityReminderSection(input: {
  previousEnabledTools: readonly string[]
  enabledTools: readonly string[]
}): QueryReminderSection | null {
  const previousEnabledToolSet = new Set(input.previousEnabledTools)
  const enabledToolSet = new Set(input.enabledTools)
  const changed = USER_MANAGED_TOOL_NAMES.some(
    (toolName) => previousEnabledToolSet.has(toolName) !== enabledToolSet.has(toolName)
  )

  if (!changed) {
    return null
  }

  return {
    key: 'tool-availability',
    title: 'Tool availability changed for this turn',
    lines: buildToolStateLines(input)
  }
}

export function buildRunModeChangedReminderSection(input: {
  previousRunMode: RunModeId
  runMode: RunModeId
  enabledTools: readonly string[]
}): QueryReminderSection | null {
  if (input.previousRunMode === input.runMode || input.runMode === 'custom') {
    return null
  }

  const mode = RUN_MODE_DEFINITIONS[input.runMode]
  return {
    key: 'run-mode',
    title: `Mode changed to ${mode.label} for this turn`,
    lines: [mode.description, ...buildToolStateLines({ enabledTools: input.enabledTools })]
  }
}

export function buildWorkspaceChangedReminderSection(input: {
  previousWorkspacePath: string
  workspacePath: string
}): QueryReminderSection | null {
  if (input.previousWorkspacePath === input.workspacePath) {
    return null
  }

  return {
    key: 'workspace-changed',
    title: 'Workspace changed for this turn',
    lines: [
      `Previous run workspace: ${input.previousWorkspacePath}.`,
      `Current workspace: ${input.workspacePath}.`,
      'Treat file paths and file mentions as relative to the current workspace unless the user says otherwise.'
    ]
  }
}

export function buildDisabledToolsReminderSection(input: {
  enabledTools: readonly string[]
}): QueryReminderSection | null {
  const enabledToolSet = new Set(input.enabledTools)
  const disabledTools = USER_MANAGED_TOOL_NAMES.filter((toolName) => !enabledToolSet.has(toolName))

  if (disabledTools.length === 0) {
    return null
  }

  return {
    key: 'disabled-tools',
    title: 'Unavailable tools',
    lines: [
      `The following tools are unavailable in this turn's mode or context and will reject calls: ${disabledTools.join(', ')}.`,
      'Do not attempt to use them unless the mode or context changes.'
    ]
  }
}

interface DateTimeParts {
  year: string
  month: string
  day: string
  weekday: string
  hour: string
  minute: string
}

function getDateTimeParts(now: Date, timeZone?: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    year: values['year'] ?? '',
    month: values['month'] ?? '',
    day: values['day'] ?? '',
    weekday: values['weekday'] ?? '',
    hour: values['hour'] ?? '',
    minute: values['minute'] ?? ''
  }
}

export function formatDateLine(now: Date = new Date(), timeZone?: string): string {
  const { year, month, day, weekday } = getDateTimeParts(now, timeZone)
  return `${year}-${month}-${day} (${weekday})`
}

export function buildCurrentTimeSection(
  now: Date = new Date(),
  { includeDate = true, timeZone }: { includeDate?: boolean; timeZone?: string } = {}
): QueryReminderSection {
  const { year, month, day, weekday, hour, minute } = getDateTimeParts(now, timeZone)
  const lines = includeDate
    ? [`Date: ${year}-${month}-${day} (${weekday})`, `Time: ${hour}:${minute}`]
    : [`Time: ${hour}:${minute}`]
  const location = timeZone || 'local'
  return {
    key: 'current-time',
    title: includeDate ? `Current date and time (${location})` : `Current time (${location})`,
    lines
  }
}

export interface InboundAttachmentReminderItem {
  index: number
  kind: 'image' | 'file'
  filename: string
  mediaType: string
  path: string
}

export function buildInboundAttachmentReminderSection(
  attachments: InboundAttachmentReminderItem[]
): QueryReminderSection | null {
  if (attachments.length === 0) {
    return null
  }

  return {
    key: 'inbound-attachments',
    title: 'Incoming attachments for this turn',
    lines: [
      'The user sent attachments. Match user references like "attachment 1" or "附件1" to the numbered list below.',
      ...attachments.map(
        (attachment) =>
          `Attachment ${attachment.index}: ${attachment.kind}; filename=${attachment.filename}; mediaType=${attachment.mediaType}; path=${attachment.path}.`
      ),
      'Images are also visible to the model when supported, but keep the listed path as the stable reference. Non-image files are available at the listed path for tool-based reading.'
    ]
  }
}

/**
 * Reminder injected when the user sends a mid-run steer message.
 * Self-contained behavioral rules so the model sees them at the steer
 * turn boundary without needing to recall the system-level protocol.
 */
export function buildSteerReminderSection(): QueryReminderSection {
  return {
    key: 'steer-guidance',
    title: 'Mid-run steer',
    lines: [
      'This message arrived while you were already working. It is a steer — an adjustment, not a new request.',
      'Acknowledge it briefly (one sentence max), absorb the adjustment, then resume your in-progress work immediately.',
      'The original objectives still stand. Do not abandon, shorten, or skip any part of the work you were doing.',
      'Before ending your turn, verify every original task is complete — not just the steer. If anything remains, keep working.'
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
