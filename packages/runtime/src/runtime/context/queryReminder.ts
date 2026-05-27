import {
  USER_MANAGED_TOOL_NAMES,
  type RunModeId,
  type ToolCallName
} from '@yachiyo/shared/protocol'
import { RUN_MODE_DEFINITIONS } from '@yachiyo/shared/toolModes'

export interface QueryReminderSection {
  key: string
  title: string
  lines: string[]
}

function formatToolList(toolNames: readonly string[]): string {
  return toolNames.length > 0 ? toolNames.join(', ') : 'none'
}

function buildToolStateLines(input: {
  enabledTools: readonly ToolCallName[]
  modeIndependentTools?: readonly string[]
}): string[] {
  const enabledToolSet = new Set(input.enabledTools)
  const enabledTools = [
    ...USER_MANAGED_TOOL_NAMES.filter((toolName) => enabledToolSet.has(toolName)),
    ...new Set(input.modeIndependentTools ?? [])
  ]
  const disabledTools = USER_MANAGED_TOOL_NAMES.filter((toolName) => !enabledToolSet.has(toolName))
  return [
    `Enabled tools: ${formatToolList(enabledTools)}.`,
    `Disabled tools: ${formatToolList(disabledTools)}.`
  ]
}

export function buildToolAvailabilityReminderSection(input: {
  previousEnabledTools: ToolCallName[]
  enabledTools: ToolCallName[]
  modeIndependentTools?: readonly string[]
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
  modeIndependentTools?: readonly string[]
}): QueryReminderSection | null {
  if (input.previousRunMode === input.runMode || input.runMode === 'custom') {
    return null
  }

  const mode = RUN_MODE_DEFINITIONS[input.runMode]
  return {
    key: 'run-mode',
    title: `Mode changed to ${mode.label} for this turn`,
    lines: [
      mode.description,
      ...buildToolStateLines({
        enabledTools: mode.enabledTools,
        modeIndependentTools: input.modeIndependentTools
      })
    ]
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
