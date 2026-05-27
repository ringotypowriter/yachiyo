import type { Message, ToolCall } from '@renderer/app/types'
import type {
  BrowserAutomationSessionRecord,
  UseBrowserToolCallDetails
} from '@yachiyo/shared/protocol'
import { sortToolCallsChronologically } from '@yachiyo/shared/toolCallOrder'

export type BrowserActivityStepKind = 'browser' | 'text'

export interface BrowserActivitySession {
  session: string
  url?: string
  title?: string
  lastAction?: UseBrowserToolCallDetails['action']
  lastStatus?: ToolCall['status']
  updatedAt: string
}

export interface BrowserActivityTextStep {
  kind: 'text'
  messageId: string
  content: string
  createdAt: string
  isStreaming: boolean
}

export interface BrowserActivityBrowserStep {
  kind: 'browser'
  toolCallId: string
  session: string
  action: UseBrowserToolCallDetails['action']
  status: ToolCall['status']
  url?: string
  title?: string
  ref?: string
  createdAt: string
}

export type BrowserActivityLatestStep = BrowserActivityTextStep | BrowserActivityBrowserStep

export interface BrowserActivityState {
  sessions: BrowserActivitySession[]
  defaultSession: string | null
  latestStep: BrowserActivityLatestStep | null
}

function isBrowserDetails(details: ToolCall['details']): details is UseBrowserToolCallDetails {
  return Boolean(
    details &&
    typeof details === 'object' &&
    'kind' in details &&
    (details as { kind?: unknown }).kind === 'useBrowser'
  )
}

function getToolCallTime(toolCall: ToolCall): string {
  return toolCall.finishedAt ?? toolCall.startedAt
}

function latestAssistantTextStep(messages: readonly Message[]): BrowserActivityTextStep | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'assistant' || message.hidden) continue

    const blocks = message.textBlocks ?? []
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      const content = block?.content.trim()
      if (!block || !content) continue
      return {
        kind: 'text',
        messageId: message.id,
        content: block.content,
        createdAt: block.createdAt,
        isStreaming: message.status === 'streaming' && blockIndex === blocks.length - 1
      }
    }

    const content = message.content.trim()
    if (content) {
      return {
        kind: 'text',
        messageId: message.id,
        content: message.content,
        createdAt: message.createdAt,
        isStreaming: message.status === 'streaming'
      }
    }
  }

  return null
}

function latestBrowserStep(toolCalls: readonly ToolCall[]): BrowserActivityBrowserStep | null {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const toolCall = toolCalls[i]
    if (!toolCall || !isBrowserDetails(toolCall.details)) continue
    const details = toolCall.details
    return {
      kind: 'browser',
      toolCallId: toolCall.id,
      session: details.session,
      action: details.action,
      status: toolCall.status,
      ...((details.finalUrl ?? details.url) ? { url: details.finalUrl ?? details.url } : {}),
      ...(details.title ? { title: details.title } : {}),
      ...(details.ref ? { ref: details.ref } : {}),
      createdAt: getToolCallTime(toolCall)
    }
  }

  return null
}

export function deriveBrowserActivity(input: {
  messages: readonly Message[]
  toolCalls: readonly ToolCall[]
  sessions?: readonly BrowserAutomationSessionRecord[]
}): BrowserActivityState {
  const orderedBrowserCalls = sortToolCallsChronologically(
    input.toolCalls.filter((toolCall) => isBrowserDetails(toolCall.details))
  )
  const latestCallBySession = new Map<string, ToolCall & { details: UseBrowserToolCallDetails }>()

  for (const toolCall of orderedBrowserCalls) {
    const details = toolCall.details
    if (!isBrowserDetails(details)) continue
    latestCallBySession.set(details.session, { ...toolCall, details })
  }

  const sessions = [...(input.sessions ?? [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map<BrowserActivitySession>((session) => {
      const latestCall = latestCallBySession.get(session.session)
      return {
        session: session.session,
        ...(session.url ? { url: session.url } : {}),
        ...(session.title ? { title: session.title } : {}),
        ...(latestCall
          ? { lastAction: latestCall.details.action, lastStatus: latestCall.status }
          : {}),
        updatedAt: session.updatedAt
      }
    })

  const textStep = latestAssistantTextStep(input.messages)
  const browserStep = latestBrowserStep(orderedBrowserCalls)
  const latestStep =
    textStep && (!browserStep || textStep.createdAt.localeCompare(browserStep.createdAt) >= 0)
      ? textStep
      : browserStep

  return {
    sessions,
    defaultSession: sessions[0]?.session ?? null,
    latestStep
  }
}
