import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  MessageRecord,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallRecord
} from '@yachiyo/shared/protocol'
import { collectMessagePath } from '@yachiyo/shared/threadTree'
import { buildSeamlessThreadHandoffPrompt } from '../../../../runtime/context/threadHandoff.ts'
import { toEffectiveProviderSettings } from '../../../../settings/settingsStore.ts'
import type { RunDomainDeps } from '../runTypes.ts'
import { createSeamlessHandoffDump, type SeamlessHandoffDump } from './seamlessHandoffDump.ts'
import {
  prepareThreadHandoffContext,
  type PreparedThreadHandoffContext
} from './threadHandoffContext.ts'

export type SeamlessHandoffReason = 'preflight' | 'step-boundary' | 'context-window-error' | string

export type SeamlessHandoffResult =
  | { kind: 'completed'; dumpPath: string; summary: string }
  | { kind: 'already-covered' }
  | { kind: 'skipped'; reason: string }

export type SeamlessHandoffCoordinatorDeps = RunDomainDeps

const MESSAGE_SUMMARY_LIMIT = 900
const TOOL_SUMMARY_LIMIT = 500

function truncateForSummary(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sliceMessagesAfterWatermark(
  messages: MessageRecord[],
  watermarkMessageId: string | undefined
): MessageRecord[] {
  if (!watermarkMessageId) return messages
  const watermarkIndex = messages.findIndex((message) => message.id === watermarkMessageId)
  return watermarkIndex >= 0 ? messages.slice(watermarkIndex + 1) : messages
}

function createDumpFileName(timestamp: string, id: string): string {
  const stamp = timestamp.replace(/\D/g, '').slice(0, 14) || 'handoff'
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'checkpoint'
  return `${stamp}-${safeId}.md`
}

function hasUsableProviderSettings(settings: ProviderSettings): boolean {
  return Boolean(settings.providerName && settings.provider && settings.model)
}

function resolveHandoffSettings(input: {
  config: SettingsConfig
  fallbackSettings: ProviderSettings
  thread: ThreadRecord
}): ProviderSettings {
  try {
    const effectiveSettings = toEffectiveProviderSettings(input.config, input.thread.modelOverride)
    return hasUsableProviderSettings(effectiveSettings) ? effectiveSettings : input.fallbackSettings
  } catch {
    return input.fallbackSettings
  }
}

function summarizeSegment(input: {
  dump: SeamlessHandoffDump
  toolCalls: readonly ToolCallRecord[]
}): string {
  const segmentMessageIds = new Set(input.dump.segmentMessages.map((message) => message.id))
  const lines: string[] = []

  for (const message of input.dump.segmentMessages) {
    const content = truncateForSummary(
      compactWhitespace(message.visibleReply ?? message.content),
      MESSAGE_SUMMARY_LIMIT
    )
    lines.push(`- ${message.role} message ${message.id}: ${content || '(empty)'}`)
  }

  const segmentToolCalls = input.toolCalls
    .filter(
      (toolCall) =>
        (toolCall.requestMessageId != null && segmentMessageIds.has(toolCall.requestMessageId)) ||
        (toolCall.assistantMessageId != null && segmentMessageIds.has(toolCall.assistantMessageId))
    )
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))

  if (segmentToolCalls.length > 0) {
    lines.push('', 'Tool calls:')
    for (const toolCall of segmentToolCalls) {
      const fragments = [
        `${toolCall.toolName} ${toolCall.status}`,
        toolCall.inputSummary ? `input: ${toolCall.inputSummary}` : '',
        toolCall.outputSummary ? `output: ${toolCall.outputSummary}` : '',
        toolCall.error ? `error: ${toolCall.error}` : '',
        toolCall.cwd ? `cwd: ${toolCall.cwd}` : ''
      ].filter(Boolean)
      lines.push(
        `- ${toolCall.id}: ${truncateForSummary(fragments.join('; '), TOOL_SUMMARY_LIMIT)}`
      )
    }
  }

  return lines.join('\n')
}

export class SeamlessHandoffCoordinator {
  private readonly deps: SeamlessHandoffCoordinatorDeps
  private readonly controllers = new Set<AbortController>()

  constructor(deps: SeamlessHandoffCoordinatorDeps) {
    this.deps = deps
  }

  abort(): void {
    for (const controller of this.controllers) {
      controller.abort()
    }
    this.controllers.clear()
  }

  async handoffAtCheckpoint(
    threadId: string,
    checkpointMessageId: string,
    reason: SeamlessHandoffReason
  ): Promise<SeamlessHandoffResult> {
    const thread = this.deps.storage.getThread(threadId)
    if (!thread) return { kind: 'skipped', reason: 'thread-not-found' }
    if (thread.contextHandoffWatermarkMessageId === checkpointMessageId)
      return { kind: 'already-covered' }

    const allMessages = this.deps.loadThreadMessages(threadId)
    const checkpointMessage = allMessages.find((message) => message.id === checkpointMessageId)
    if (!checkpointMessage) return { kind: 'skipped', reason: 'checkpoint-not-found' }

    const activePathMessages = collectMessagePath(allMessages, checkpointMessageId)
    const toolCalls = this.deps.loadThreadToolCalls(threadId)
    const dump = createSeamlessHandoffDump({
      thread,
      activePathMessages,
      toolCalls,
      checkpointMessageId,
      previousWatermarkMessageId: thread.contextHandoffWatermarkMessageId
    })
    if (dump.segmentMessages.length === 0) return { kind: 'skipped', reason: 'empty-segment' }

    const workspacePath = await this.deps.ensureThreadWorkspace(threadId)
    const dumpDir = join(workspacePath, '.yachiyo', 'context-handoffs')
    await mkdir(dumpDir, { recursive: true })
    const dumpPath = join(dumpDir, createDumpFileName(this.deps.timestamp(), this.deps.createId()))
    await writeFile(dumpPath, dump.markdown, 'utf8')

    const config = this.deps.readConfig()
    const settings = resolveHandoffSettings({
      config,
      fallbackSettings: this.deps.readSettings(),
      thread
    })
    const runtime = this.deps.createModelRuntime()
    const controller = new AbortController()
    this.controllers.add(controller)
    let handoffContext: PreparedThreadHandoffContext
    try {
      handoffContext = await prepareThreadHandoffContext({
        deps: this.deps,
        sourceThread: thread,
        sourceMessages: sliceMessagesAfterWatermark(
          activePathMessages,
          thread.contextHandoffWatermarkMessageId
        ),
        requestContent: buildSeamlessThreadHandoffPrompt({
          previousContextHandoffSummary: thread.contextHandoffSummary,
          checkpointSegmentSummary: summarizeSegment({ dump, toolCalls }),
          checkpointDumpPath: dumpPath,
          reason
        }),
        runId: checkpointMessageId,
        settings,
        config,
        abortController: controller
      })
    } catch (error) {
      this.controllers.delete(controller)
      throw error
    }

    const summaryParts: string[] = []
    try {
      for await (const delta of runtime.streamReply({
        messages: handoffContext.preparedContext.messages,
        settings,
        signal: controller.signal,
        purpose: 'thread-handoff',
        promptCacheKey: thread.id,
        ...(handoffContext.tools
          ? {
              tools: handoffContext.tools,
              stopWhen: handoffContext.stopWhen,
              onToolCallError: handoffContext.onToolCallError
            }
          : {})
      })) {
        if (delta) summaryParts.push(delta)
      }
    } catch (error) {
      if (controller.signal.aborted) throw error
      return { kind: 'skipped', reason: 'summary-generation-failed' }
    } finally {
      this.controllers.delete(controller)
    }

    const summary = summaryParts.join('').trim()
    if (!summary) return { kind: 'skipped', reason: 'empty-summary' }

    const latestThread = this.deps.storage.getThread(threadId)
    if (!latestThread) return { kind: 'skipped', reason: 'thread-not-found-after-summary' }
    const updatedThread: ThreadRecord = {
      ...latestThread,
      contextHandoffSummary: summary,
      contextHandoffWatermarkMessageId: checkpointMessageId,
      updatedAt: this.deps.timestamp()
    }
    this.deps.storage.updateThread(updatedThread)
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId,
      thread: updatedThread
    })

    return { kind: 'completed', dumpPath, summary }
  }
}
