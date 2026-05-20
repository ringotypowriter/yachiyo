import type { MessageRecord, RunRecord } from './protocol.ts'

export const PLAN_MODE_EXIT_PHRASE = 'Exit Plan Mode'

export const PLAN_MODE_EXIT_TOOL_NAME = 'exitPlanMode'

export const PLAN_DOCUMENT_MARKER = '<!-- yachiyo:plan-document -->'

export function isPlanModeExitMessage(content: string): boolean {
  return content.trim() === PLAN_MODE_EXIT_PHRASE
}

function valueContainsExitPlanModeToolCall(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)

  if ('toolName' in value && value.toolName === PLAN_MODE_EXIT_TOOL_NAME) return true
  if ('tool_name' in value && value.tool_name === PLAN_MODE_EXIT_TOOL_NAME) return true
  if ('name' in value && value.name === PLAN_MODE_EXIT_TOOL_NAME) return true

  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsExitPlanModeToolCall(entry, seen))
  }

  return Object.values(value).some((entry) => valueContainsExitPlanModeToolCall(entry, seen))
}

export function hasExitPlanModeToolCall(responseMessages: unknown): boolean {
  return valueContainsExitPlanModeToolCall(responseMessages)
}

export function isPlanModeExitRecord(input: {
  content: string
  responseMessages?: unknown
}): boolean {
  return hasExitPlanModeToolCall(input.responseMessages) || isPlanModeExitMessage(input.content)
}

export function isLatestRunPlanMode(input: {
  latestRun?: Pick<RunRecord, 'requestMessageId' | 'runMode'> | null
  messages: readonly Pick<MessageRecord, 'id' | 'turnContext'>[]
}): boolean {
  if (input.latestRun?.runMode === 'plan') return true

  const requestMessageId = input.latestRun?.requestMessageId
  if (!requestMessageId) return false

  return input.messages.some(
    (message) => message.id === requestMessageId && message.turnContext?.runMode === 'plan'
  )
}

export function isPlanDocumentMessage(content: string): boolean {
  return content.trimStart().startsWith(PLAN_DOCUMENT_MARKER)
}

export function stripPlanDocumentMarker(content: string): string {
  if (!isPlanDocumentMessage(content)) return content
  return content.trimStart().slice(PLAN_DOCUMENT_MARKER.length).trimStart()
}
