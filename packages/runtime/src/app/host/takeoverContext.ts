import { basename } from 'node:path'

import type {
  MessageRecord,
  SettingsConfig,
  ThreadRecord,
  ToolCallRecord
} from '@yachiyo/shared/protocol'
import { sortToolCallsChronologically } from '@yachiyo/shared/toolCallOrder'
import { collectMessagePath, sortMessagesByCreatedAt } from '@yachiyo/shared/threadTree'
import { DEFAULT_THREAD_TITLE } from '../domain/shared/shared.ts'

const TAKEOVER_MESSAGE_LIMIT = 6

const TAKEOVER_TOOL_LIMIT = 3
const TAKEOVER_MESSAGE_TEXT_LIMIT = 500
const TAKEOVER_RECAP_TEXT_LIMIT = 1_800
const TAKEOVER_LAST_REPLY_TEXT_LIMIT = 800
const TAKEOVER_TOOL_TEXT_LIMIT = 140
export const TAKEOVER_SECTION_DIVIDER = '---'

function formatTakeoverThreadTitle(thread: Pick<ThreadRecord, 'title' | 'icon'>): string {
  return thread.icon ? `${thread.icon} ${thread.title}` : thread.title
}

export function isOwnerDmTakeoverCandidate(thread: ThreadRecord): boolean {
  if (thread.channelGroupId) {
    return false
  }
  if (thread.channelUserId && thread.channelUserRole !== 'owner') {
    return false
  }
  if (!thread.source || thread.source === 'local') {
    return true
  }
  return thread.channelUserRole === 'owner'
}

function truncateForTakeover(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) {
    return trimmed
  }
  return `${trimmed.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

function truncateHeadTailForTakeover(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) {
    return trimmed
  }
  const ellipsis = '\n…\n'
  const budget = limit - ellipsis.length
  const headBudget = Math.ceil(budget * 0.6)
  const tailBudget = budget - headBudget
  const head = trimmed.slice(0, headBudget).trimEnd()
  const tail = trimmed.slice(-tailBudget).trimStart()
  return `${head}${ellipsis}${tail}`
}

function compactForTakeover(text: string, limit: number): string {
  return truncateForTakeover(text.replace(/\s+/g, ' '), limit)
}

function visibleTakeoverMessageText(message: MessageRecord): string {
  const text = (message.visibleReply ?? message.content).trim()
  if (text) {
    return text
  }
  return (
    message.textBlocks
      ?.map((block) => block.content)
      .join('')
      .trim() ?? ''
  )
}

function takeoverMessageRoleLabel(message: MessageRecord): string {
  return message.role === 'assistant' ? 'Assistant' : 'User'
}

function selectTakeoverMessagePath(
  thread: ThreadRecord,
  messages: MessageRecord[]
): MessageRecord[] {
  if (thread.headMessageId && messages.some((message) => message.id === thread.headMessageId)) {
    return collectMessagePath(messages, thread.headMessageId)
  }
  return sortMessagesByCreatedAt(messages)
}

function visibleTakeoverMessages(thread: ThreadRecord, messages: MessageRecord[]): MessageRecord[] {
  return selectTakeoverMessagePath(thread, messages).filter((message) => {
    if (message.hidden) {
      return false
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return false
    }
    return visibleTakeoverMessageText(message).length > 0
  })
}

export function isDefaultNewChatThread(thread: Pick<ThreadRecord, 'title'>): boolean {
  return thread.title === DEFAULT_THREAD_TITLE
}

export function isBlankNewChatThread(thread: ThreadRecord, messages: MessageRecord[]): boolean {
  return isDefaultNewChatThread(thread) && visibleTakeoverMessages(thread, messages).length === 0
}

function messagesAfterWatermark(
  messages: MessageRecord[],
  watermarkMessageId?: string
): MessageRecord[] {
  if (!watermarkMessageId) {
    return []
  }
  const watermarkIndex = messages.findIndex((message) => message.id === watermarkMessageId)
  if (watermarkIndex < 0) {
    return []
  }
  return messages.slice(watermarkIndex + 1)
}

function formatTakeoverMessage(message: MessageRecord): string {
  return `${takeoverMessageRoleLabel(message)}: ${compactForTakeover(
    visibleTakeoverMessageText(message),
    TAKEOVER_MESSAGE_TEXT_LIMIT
  )}`
}

function formatTakeoverToolCall(toolCall: ToolCallRecord): string {
  const summary = compactForTakeover(toolCall.inputSummary, TAKEOVER_TOOL_TEXT_LIMIT)
  const status =
    toolCall.status === 'failed' && toolCall.error
      ? `failed: ${compactForTakeover(toolCall.error, TAKEOVER_TOOL_TEXT_LIMIT)}`
      : toolCall.status
  return `- ${toolCall.toolName}${summary ? ` ${summary}` : ''} — ${status}`
}

function appendTakeoverSection(lines: string[], title: string, content: string[]): void {
  if (lines.length > 0) {
    lines.push('', TAKEOVER_SECTION_DIVIDER, '')
  }
  lines.push(title, ...content)
}

function selectTakeoverToolCalls(input: {
  messages: MessageRecord[]
  thread: ThreadRecord
  toolCalls: ToolCallRecord[]
}): ToolCallRecord[] {
  const sortedToolCalls = sortToolCallsChronologically(input.toolCalls)
  const afterWatermark = messagesAfterWatermark(
    input.messages,
    input.thread.contextHandoffWatermarkMessageId
  )
  if (afterWatermark.length === 0) {
    return sortedToolCalls.slice(-TAKEOVER_TOOL_LIMIT)
  }

  const afterWatermarkIds = new Set(afterWatermark.map((message) => message.id))
  const matchingToolCalls = sortedToolCalls.filter((toolCall) => {
    if (toolCall.requestMessageId && afterWatermarkIds.has(toolCall.requestMessageId)) {
      return true
    }
    return !!toolCall.assistantMessageId && afterWatermarkIds.has(toolCall.assistantMessageId)
  })
  return matchingToolCalls.slice(-TAKEOVER_TOOL_LIMIT)
}

export function formatConversationSummary(input: {
  messages: MessageRecord[]
  thread: ThreadRecord
  toolCalls: ToolCallRecord[]
}): string {
  const messages = visibleTakeoverMessages(input.thread, input.messages)
  const recap = (input.thread.recapText ?? input.thread.contextHandoffSummary ?? '').trim()
  const sinceRecap = messagesAfterWatermark(messages, input.thread.contextHandoffWatermarkMessageId)
  const conversationMessages = recap
    ? sinceRecap.slice(-TAKEOVER_MESSAGE_LIMIT)
    : messages.slice(-TAKEOVER_MESSAGE_LIMIT)
  const toolCalls = selectTakeoverToolCalls({
    messages,
    thread: input.thread,
    toolCalls: input.toolCalls
  })

  const lines: string[] = []

  if (recap) {
    appendTakeoverSection(lines, 'Last recap:', [
      truncateForTakeover(recap, TAKEOVER_RECAP_TEXT_LIMIT)
    ])
  }

  if (conversationMessages.length > 0) {
    appendTakeoverSection(
      lines,
      recap ? 'Since then:' : 'Recent conversation:',
      conversationMessages.map(formatTakeoverMessage)
    )
  } else if (!recap) {
    appendTakeoverSection(lines, 'Recent conversation:', ['No visible conversation yet.'])
  }

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === 'assistant')
  if (lastAssistantMessage) {
    const replyText = visibleTakeoverMessageText(lastAssistantMessage)
    if (replyText) {
      appendTakeoverSection(lines, 'Last reply:', [
        truncateHeadTailForTakeover(replyText, TAKEOVER_LAST_REPLY_TEXT_LIMIT)
      ])
    }
  }

  if (toolCalls.length > 0) {
    appendTakeoverSection(lines, 'Recent tool activity:', toolCalls.map(formatTakeoverToolCall))
  }

  return lines.join('\n')
}

export function formatOwnerDmTakeoverContext(input: {
  messages: MessageRecord[]
  thread: ThreadRecord
  toolCalls: ToolCallRecord[]
}): string {
  const header = `Took over:\n${formatTakeoverThreadTitle(input.thread)}`
  const summary = formatConversationSummary(input)
  if (!summary) {
    return header
  }
  return [header, '', TAKEOVER_SECTION_DIVIDER, '', summary].join('\n')
}

function formatTakeoverTokenCount(tokens: number): string {
  return `${Math.ceil(Math.max(0, tokens) / 1_000)}k`
}

export function formatTakeoverTokens(tokens: number, limit: number): string {
  const used = formatTakeoverTokenCount(tokens)
  if (limit <= 0) {
    return `${used} / unlimited`
  }
  const normalizedTokens = Math.max(0, tokens)
  const percent = Math.round((normalizedTokens / limit) * 100)
  const remaining = Math.max(0, limit - normalizedTokens)
  return `${used} / ${formatTakeoverTokenCount(limit)} (${percent}%, ${formatTakeoverTokenCount(
    remaining
  )} remaining)`
}

export function formatTakeoverWorkspace(path: string, config: SettingsConfig): string {
  const configuredLabel = config.workspace?.pathLabels?.[path]?.trim()
  const label = configuredLabel || basename(path) || path
  return label === path ? path : `${label} (${path})`
}
