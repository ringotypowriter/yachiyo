import type { ToolSet } from 'ai'

import type {
  ComposerReasoningSelection,
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  RunCreatedEvent,
  SendChatRunTrigger,
  ThreadRecord,
  ToolCallUpdatedEvent,
  ToolCallName
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { createRunEventMetadata } from '../../shared/runEventMetadata.ts'
import { streamCompactThreadHandoff } from '../handoff/threadHandoffRun.ts'
import type { RunDomainDeps, RunState } from '../runTypes.ts'
import type { ThreadTitleGenerationRunner } from '../title/threadTitleGeneration.ts'
import { createTodoProgressState } from '../todo/todoProgress.ts'

export interface ActiveRunLoopInput {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  channelHint?: string
  extraTools?: ToolSet
  recoveryCheckpoint?: RunRecoveryCheckpoint
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  updateHeadOnComplete: boolean
}

export interface StartActiveRunInput extends ActiveRunLoopInput {
  recap?: boolean
}

export interface StartAssistantOnlyRunInput {
  runId: string
  thread: ThreadRecord
  sourceThreadId: string
  sourceMessages: MessageRecord[]
  reasoningEffort?: ComposerReasoningSelection
}

export interface ActiveRunStartContext {
  deps: RunDomainDeps
  activeRuns: Map<string, RunState>
  activeRunByThread: Map<string, string>
  activeRunTasks: Map<string, Promise<void>>
  isClosing: () => boolean
  runLoop: (input: ActiveRunLoopInput) => Promise<void>
  threadTitleRunner: ThreadTitleGenerationRunner
}

export function startActiveRun(context: ActiveRunStartContext, input: StartActiveRunInput): void {
  context.activeRuns.set(input.runId, {
    threadId: input.thread.id,
    requestMessageId: input.requestMessageId,
    ...(input.enabledSkillNames ? { enabledSkillNames: [...input.enabledSkillNames] } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    runTrigger: input.runTrigger,
    ...(input.channelHint ? { channelHint: input.channelHint } : {}),
    ...(input.recoveryCheckpoint ? { recoveryCheckpoint: input.recoveryCheckpoint } : {}),
    abortController: new AbortController(),
    executionPhase: 'generating',
    updateHeadOnComplete: input.updateHeadOnComplete,
    ...(input.thread.todoItems
      ? { todoProgress: createTodoProgressState({ items: input.thread.todoItems, step: 0 }) }
      : {}),
    ...(input.recap ? { recap: true } : {})
  })
  context.activeRunByThread.set(input.thread.id, input.runId)

  const runTask = context.runLoop({
    enabledTools: input.enabledTools,
    enabledSkillNames: input.enabledSkillNames,
    reasoningEffort: input.reasoningEffort,
    runTrigger: input.runTrigger,
    channelHint: input.channelHint,
    extraTools: input.extraTools,
    recoveryCheckpoint: input.recoveryCheckpoint,
    runId: input.runId,
    thread: input.thread,
    requestMessageId: input.requestMessageId,
    updateHeadOnComplete: input.updateHeadOnComplete
  })
  context.activeRunTasks.set(input.runId, runTask)
  void runTask
}

export function startRecoveredRun(
  context: ActiveRunStartContext,
  checkpoint: RunRecoveryCheckpoint
): void {
  if (context.isClosing() || context.activeRunByThread.has(checkpoint.threadId)) {
    return
  }

  const thread = context.deps.requireThread(checkpoint.threadId)
  const toolCalls = context.deps
    .loadThreadToolCalls(thread.id)
    .filter((toolCall) => toolCall.runId === checkpoint.runId)

  context.deps.emit<RunCreatedEvent>({
    type: 'run.created',
    ...createRunEventMetadata({
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      requestMessageId: checkpoint.requestMessageId,
      runTrigger: checkpoint.runTrigger
    })
  })
  context.deps.emit<MessageStartedEvent>({
    type: 'message.started',
    threadId: checkpoint.threadId,
    runId: checkpoint.runId,
    messageId: checkpoint.assistantMessageId,
    parentMessageId: checkpoint.requestMessageId
  })
  if (checkpoint.reasoning) {
    context.deps.emit<MessageReasoningDeltaEvent>({
      type: 'message.reasoning.delta',
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      messageId: checkpoint.assistantMessageId,
      delta: checkpoint.reasoning
    })
  }
  if (checkpoint.content) {
    context.deps.emit<MessageDeltaEvent>({
      type: 'message.delta',
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      messageId: checkpoint.assistantMessageId,
      delta: checkpoint.content
    })
  }
  for (const toolCall of toolCalls) {
    context.deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      toolCall
    })
  }

  context.activeRuns.set(checkpoint.runId, {
    threadId: checkpoint.threadId,
    requestMessageId: checkpoint.requestMessageId,
    ...(checkpoint.enabledSkillNames
      ? { enabledSkillNames: [...checkpoint.enabledSkillNames] }
      : {}),
    ...(checkpoint.reasoningEffort !== undefined
      ? { reasoningEffort: checkpoint.reasoningEffort }
      : {}),
    runTrigger: checkpoint.runTrigger,
    ...(checkpoint.channelHint ? { channelHint: checkpoint.channelHint } : {}),
    recoveryCheckpoint: checkpoint,
    abortController: new AbortController(),
    executionPhase: 'generating',
    updateHeadOnComplete: checkpoint.updateHeadOnComplete,
    ...(thread.todoItems
      ? { todoProgress: createTodoProgressState({ items: thread.todoItems, step: 0 }) }
      : {})
  })
  context.activeRunByThread.set(checkpoint.threadId, checkpoint.runId)

  const runTask = context.runLoop({
    enabledTools: checkpoint.enabledTools,
    enabledSkillNames: checkpoint.enabledSkillNames,
    reasoningEffort: checkpoint.reasoningEffort,
    runTrigger: checkpoint.runTrigger,
    channelHint: checkpoint.channelHint,
    recoveryCheckpoint: checkpoint,
    runId: checkpoint.runId,
    thread,
    requestMessageId: checkpoint.requestMessageId,
    updateHeadOnComplete: checkpoint.updateHeadOnComplete
  })
  context.activeRunTasks.set(checkpoint.runId, runTask)
  void runTask
}

export function startAssistantOnlyRun(
  context: ActiveRunStartContext,
  input: StartAssistantOnlyRunInput
): void {
  context.activeRuns.set(input.runId, {
    threadId: input.thread.id,
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    abortController: new AbortController(),
    executionPhase: 'generating',
    updateHeadOnComplete: true
  })
  context.activeRunByThread.set(input.thread.id, input.runId)

  const runTask = streamCompactThreadHandoff(
    {
      deps: context.deps,
      activeRuns: context.activeRuns,
      activeRunByThread: context.activeRunByThread,
      activeRunTasks: context.activeRunTasks,
      threadTitleRunner: context.threadTitleRunner
    },
    input
  )
  context.activeRunTasks.set(input.runId, runTask)
  void runTask
}
