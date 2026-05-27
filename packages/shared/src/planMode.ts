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

export function findPlanExitTimestamp(input: {
  messages: readonly Pick<MessageRecord, 'role' | 'content' | 'responseMessages' | 'createdAt'>[]
  toolCalls: readonly { toolName: string; status: string; startedAt: string; finishedAt?: string }[]
}): string | null {
  for (let i = input.toolCalls.length - 1; i >= 0; i -= 1) {
    const toolCall = input.toolCalls[i]
    if (toolCall?.toolName === PLAN_MODE_EXIT_TOOL_NAME && toolCall.status === 'completed') {
      return toolCall.finishedAt ?? toolCall.startedAt
    }
  }

  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i]
    if (message?.role === 'assistant' && isPlanModeExitRecord(message)) {
      return message.createdAt
    }
  }

  return null
}

export function findPlanAcceptanceTimestamp(input: {
  messages: readonly Pick<
    MessageRecord,
    'id' | 'parentMessageId' | 'role' | 'content' | 'createdAt'
  >[]
  planExitTimestamp: string
}): string | null {
  const messagesById = new Map(input.messages.map((message) => [message.id, message]))

  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i]
    if (!message || message.role !== 'user') continue
    if (message.content.trim() !== PLAN_EXECUTION_USER_MESSAGE) continue
    if (!message.parentMessageId) continue

    const parent = messagesById.get(message.parentMessageId)
    if (!parent || parent.role !== 'assistant') continue
    if (!isPlanDocumentMessage(parent.content)) continue
    if (message.createdAt.localeCompare(input.planExitTimestamp) < 0) continue

    return message.createdAt
  }

  return null
}

export function hasPendingPlanDocument(input: {
  messages: readonly Pick<
    MessageRecord,
    'id' | 'parentMessageId' | 'role' | 'content' | 'responseMessages' | 'createdAt'
  >[]
  toolCalls: readonly { toolName: string; status: string; startedAt: string; finishedAt?: string }[]
}): boolean {
  const planExitTimestamp = findPlanExitTimestamp(input)
  if (!planExitTimestamp) return false
  return !findPlanAcceptanceTimestamp({ messages: input.messages, planExitTimestamp })
}

export function stripPlanDocumentMarker(content: string): string {
  if (!isPlanDocumentMessage(content)) return content
  return content.trimStart().slice(PLAN_DOCUMENT_MARKER.length).trimStart()
}
