import type {
  BackgroundTaskCompletedEvent,
  ChatAccepted,
  SendChatMode,
  ThreadRecord,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '@yachiyo/shared/protocol'
import type { BackgroundBashTaskResult } from '../../background/backgroundBashManager.ts'
import type { BackgroundTaskRunContext, InternalSendChatInput, RunDomainDeps } from '../runTypes.ts'
import {
  buildBackgroundCompletionMessage,
  isBackgroundAutoDeliveryEligible
} from './backgroundTaskDelivery.ts'
import {
  getCompletedBackgroundBashError,
  getCompletedBackgroundBashOutputSummary,
  getCompletedBackgroundBashStatus
} from '../tools/backgroundBashToolResult.ts'

export interface BackgroundTaskLifecycleContext {
  deps: RunDomainDeps
  backgroundTaskRunContext: Map<string, BackgroundTaskRunContext>
  isClosing: () => boolean
  sendChat: (input: InternalSendChatInput) => Promise<ChatAccepted>
  deliverToAgent?: (input: { agentId: string; threadId: string; message: string }) => void
}

export function recoverOrphanedBackgroundToolCalls(context: BackgroundTaskLifecycleContext): void {
  const timestamp = context.deps.timestamp()
  const bootstrap = context.deps.storage.bootstrap()

  // Walk every thread that could possibly own a background bash tool call: active local
  // threads, archived threads, and external/channel threads. The default `bootstrap()`
  // result excludes archived and (in sqlite) channel threads, so a background task
  // launched in an archived conversation or an owner DM would otherwise be stuck in an
  // active-looking state forever after a restart.
  const seen = new Set<string>()
  const allThreads: ThreadRecord[] = []
  const collect = (thread: ThreadRecord): void => {
    if (seen.has(thread.id)) return
    seen.add(thread.id)
    allThreads.push(thread)
  }
  for (const thread of bootstrap.threads) collect(thread)
  for (const thread of bootstrap.archivedThreads) collect(thread)
  for (const thread of context.deps.storage.listExternalThreads()) collect(thread)

  for (const thread of allThreads) {
    const toolCalls = context.deps.loadThreadToolCalls(thread.id)
    for (const tc of toolCalls) {
      if (tc.status === 'background') {
        const updated: ToolCallRecord = {
          ...tc,
          status: 'failed',
          error: 'Background task interrupted by app restart',
          finishedAt: timestamp
        }
        context.deps.storage.updateToolCall(updated)
      }
    }
  }
}

export function handleBackgroundBashCompleted(
  context: BackgroundTaskLifecycleContext,
  result: BackgroundBashTaskResult
): void {
  if (context.isClosing()) return

  try {
    const timestamp = context.deps.timestamp()

    // 1. Update ToolCallRecord status/exitCode for the renderer. The model-facing
    // `output` blob is left untouched: history must remain truthful that the launch
    // call only ever returned the `{taskId, logPath}` handle.
    const cancelled = result.cancelledByUser === true
    const terminalStatus = getCompletedBackgroundBashStatus(result)
    const outputSummary = getCompletedBackgroundBashOutputSummary(result)
    const completionError = getCompletedBackgroundBashError(result)

    if (result.toolCallId) {
      const toolCalls = context.deps.loadThreadToolCalls(result.threadId)
      const tc = toolCalls.find((t) => t.id === result.toolCallId)
      if (tc?.status === 'background') {
        const baseDetails =
          tc.details && typeof tc.details === 'object'
            ? (tc.details as unknown as Record<string, unknown>)
            : {}
        const updated: ToolCallRecord = {
          ...tc,
          status: terminalStatus,
          outputSummary,
          details: {
            ...baseDetails,
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
            ...(cancelled ? { cancelledByUser: true } : {})
          } as unknown as ToolCallRecord['details'],
          ...(completionError ? { error: completionError } : {}),
          finishedAt: timestamp
        }
        context.deps.storage.updateToolCall(updated)
        context.deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: result.threadId,
          runId: tc.runId,
          toolCall: updated
        })
      }
    }

    // 2. Emit background task completion event for the renderer/notifications.
    context.deps.emit<BackgroundTaskCompletedEvent>({
      type: 'background-task.completed',
      threadId: result.threadId,
      taskId: result.taskId,
      command: result.command,
      ...(result.description ? { description: result.description } : {}),
      logPath: result.logPath,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      toolCallId: result.toolCallId,
      ...(cancelled ? { cancelledByUser: true } : {}),
      ...(result.error !== undefined ? { error: result.error } : {})
    })

    // 3. Auto-deliver the completion notice as a hidden system steer via sendChat,
    // for local threads and owner DMs. Skip when the user manually cancelled —
    // they already know, and triggering a model run would be noise.
    const ctx = context.backgroundTaskRunContext.get(result.taskId)
    context.backgroundTaskRunContext.delete(result.taskId)
    if (!cancelled) {
      void autoDeliverBackgroundCompletion(context, result, ctx)
    }
  } catch (error) {
    // Thread may have been deleted while background task was running
    console.warn('[yachiyo][background-bash] completion handler failed', {
      taskId: result.taskId,
      threadId: result.threadId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function autoDeliverBackgroundCompletion(
  context: BackgroundTaskLifecycleContext,
  result: BackgroundBashTaskResult,
  ctx: BackgroundTaskRunContext | undefined
): Promise<void> {
  const content = buildBackgroundCompletionMessage(result)
  if (ctx?.ownerAgentId && context.deliverToAgent) {
    try {
      context.deliverToAgent({
        agentId: ctx.ownerAgentId,
        threadId: result.threadId,
        message: content
      })
      return
    } catch (error) {
      console.warn('[yachiyo][background-bash] owner Agent delivery failed', {
        taskId: result.taskId,
        agentId: ctx.ownerAgentId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  let thread: ThreadRecord
  try {
    thread = context.deps.requireThread(result.threadId)
  } catch {
    // Thread was deleted between launch and completion. Nothing to do.
    return
  }

  if (
    !isBackgroundAutoDeliveryEligible(thread, (channelUserId) =>
      context.deps.storage.getChannelUser(channelUserId)
    )
  ) {
    return
  }
  const chatOptions = {
    threadId: thread.id,
    content,
    hidden: true,
    ...(ctx?.enabledTools ? { toolPreset: ctx.enabledTools } : {}),
    ...(ctx?.runMode ? { runMode: ctx.runMode } : {}),
    ...(ctx?.enabledSkillNames ? { enabledSkillNames: ctx.enabledSkillNames } : {}),
    ...(ctx?.reasoningEffort !== undefined ? { reasoningEffort: ctx.reasoningEffort } : {}),
    ...(ctx?.runTrigger ? { runTrigger: ctx.runTrigger } : {}),
    ...(ctx?.channelHint ? { channelHint: ctx.channelHint } : {}),
    ...(ctx?.extraTools ? { extraTools: ctx.extraTools } : {})
  }
  try {
    // Prefer steer so the completion notice is injected into the active run's
    // context at the next turn boundary instead of spawning a separate run.
    // Falls back to follow-up when no active run exists or the steer is rejected.
    await context.sendChat({ ...chatOptions, mode: 'steer' as SendChatMode })
  } catch {
    // Steer rejected (no active run, or handoff not ready) — fall back to
    // follow-up which queues gracefully or starts a fresh run.
    try {
      await context.sendChat({ ...chatOptions, mode: 'follow-up' })
    } catch (error) {
      console.warn('[yachiyo][background-bash] auto-delivery sendChat failed', {
        threadId: thread.id,
        taskId: result.taskId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
