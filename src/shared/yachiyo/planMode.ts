import type { MessageRecord, RunRecord } from './protocol.ts'

export const PLAN_MODE_EXIT_PHRASE = 'Exit Plan Mode'

export const PLAN_EXECUTION_USER_MESSAGE = 'Execute the accepted plan.'

export const PLAN_MODE_EXIT_TOOL_NAME = 'exitPlanMode'

export const PLAN_DOCUMENT_MARKER = '<!-- yachiyo:plan-document -->'
export const PLAN_DOCUMENT_DIR_NAME = '.yachiyo'
export const PLAN_DOCUMENT_FILENAME_PATTERN = /^plan-[a-z0-9_-]{1,128}\.md$/i

export const PLAN_DOCUMENT_STATE_FILENAME_PATTERN = /^plan-[a-z0-9_-]{1,128}\.state\.json$/i

export interface ThreadPlanDocumentStateFile {
  decision: 'accepted'
  acceptedAt: string
  acceptedMode: 'direct' | 'handoff'
  acceptedThreadId: string
  planContentHash: string
}

export function getThreadPlanDocumentFilename(threadId: string): string {
  let hash = 2166136261

  for (const character of threadId.trim().toLowerCase()) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }

  const letters = Array.from({ length: 8 }, (_, index) => {
    const value = (hash >>> ((index % 4) * 8)) + index * 37
    return String.fromCharCode(97 + (value % 26))
  }).join('')

  return `plan-${letters}.md`
}

export function normalizePlanDocumentFilename(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || !PLAN_DOCUMENT_FILENAME_PATTERN.test(trimmed)) return null
  return trimmed.toLowerCase()
}

export function getThreadPlanDocumentStateFilename(threadId: string): string {
  return getThreadPlanDocumentFilename(threadId).replace(/\.md$/i, '.state.json')
}

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
