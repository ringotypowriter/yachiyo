import { stepCountIs, type ToolSet } from 'ai'

import { DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD } from '@yachiyo/shared/protocol'
import type {
  AgentMessageEnvelope,
  AgentMessageReceipt,
  NamedSubagentId,
  ProviderSettings,
  SettingsConfig,
  SendAgentMessageInput,
  SkillSummary,
  ToolCallName
} from '@yachiyo/shared/protocol'
import type {
  SubagentParentDeliveryContext,
  SubagentRunner,
  SubagentRunnerFactory,
  SubagentRunnerFactoryInput,
  SubagentRunnerTurnInput,
  SubagentTurnResult
} from './subagentManager.ts'
import { createWorkerHistoryCompactor } from './workerSubagentCompaction.ts'
import {
  ReadRecordCache,
  createAgentToolSet,
  summarizeToolInput,
  summarizeToolOutput,
  type AgentToolDependencies
} from '../../../tools/agentTools.ts'
import { type AgentToolContext } from '../../../tools/agentTools/shared.ts'
import { applyAnthropicCacheBreakpoints } from '../../../runtime/context/contextLayers.ts'
import type { ModelMessage, ModelRuntime } from '../../../runtime/models/types.ts'
import { toSubagentProviderSettings } from '../../../settings/settingsStore.ts'
import { DEFAULT_NAMED_SUBAGENT_PROFILES } from '../../../settings/namedSubagents.ts'
import type { SnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'
import { SnapshotTracker as WorkerSnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'

export interface WorkerSubagentRunnerDependencies {
  settings: ProviderSettings
  config?: SettingsConfig
  activeSkills?: SkillSummary[]
  parentToolContext: AgentToolContext
  parentDependencies: AgentToolDependencies
  createModelRuntime: () => ModelRuntime
  parentDeliveryContext?: SubagentParentDeliveryContext
  backgroundBashContext?: AgentToolDependencies['backgroundBashContext']
}

type WorkerProfile = (typeof DEFAULT_NAMED_SUBAGENT_PROFILES)[NamedSubagentId]

interface AgentMessageContextLike {
  sender: { kind: 'agent'; agentId: string }
  dispatch: (input: SendAgentMessageInput) => AgentMessageReceipt
}

export interface WorkerRunnerFactoryInput {
  profileId: NamedSubagentId
  profile: WorkerProfile
  dependencies: WorkerSubagentRunnerDependencies
}

const WORKSPACE_CONCURRENCY_INSTRUCTION = [
  'Other Worker Agents may modify this workspace concurrently.',
  'Re-read files immediately before writing; stale edit anchors or unexpected test results require coordination through sendMessage.',
  'Do not revert, overwrite, or delete changes whose ownership you cannot confirm.',
  'A successful tool call is not proof of the final workspace state; re-read and verify before reporting.'
].join(' ')

function buildWorkerSystemPrompt(
  baseSystemPrompt: string,
  activeSkillNames: string[],
  hasSkillsRead: boolean,
  identity: { agentId: string; parentThreadId: string }
): string {
  const sections = [
    baseSystemPrompt,
    `You are Worker Agent ${identity.agentId} in team thread ${identity.parentThreadId}. Use sendMessage with to "parent" for parent updates or an exact agent ID for peer messages. A queued receipt is not a reply.`,
    WORKSPACE_CONCURRENCY_INSTRUCTION
  ]
  if (hasSkillsRead && activeSkillNames.length > 0) {
    sections.push(`Active Skills: ${activeSkillNames.join(', ')}.`)
  }
  return sections.join('\n\n')
}

function mailboxMessage(envelope: AgentMessageEnvelope): ModelMessage {
  const sender = envelope.from.kind === 'agent' ? `agent ${envelope.from.agentId}` : 'parent'
  return {
    role: 'user',
    content: `[Message from ${sender}]\n${envelope.message}`
  }
}

function asToolSetDisposer(tools: ToolSet | undefined): () => Promise<void> {
  return async () => {
    const disposals: Promise<void>[] = []
    for (const tool of Object.values(tools ?? {})) {
      const disposable = tool as { dispose?: () => Promise<void> | void }
      if (typeof disposable.dispose === 'function') {
        disposals.push(Promise.resolve(disposable.dispose()))
      }
    }
    await Promise.all(disposals)
  }
}
function sanitizeWorkerRunnerInput(input: WorkerRunnerFactoryInput): WorkerRunnerFactoryInput {
  const parentToolContextInput = input.dependencies.parentToolContext
  const parentDependenciesInput = input.dependencies.parentDependencies
  const parentDependencies: AgentToolDependencies = {
    ...(parentDependenciesInput.availableSkills
      ? { availableSkills: [...parentDependenciesInput.availableSkills] }
      : {}),
    ...(parentDependenciesInput.fetchImpl ? { fetchImpl: parentDependenciesInput.fetchImpl } : {}),
    ...(parentDependenciesInput.searchService
      ? { searchService: parentDependenciesInput.searchService }
      : {}),
    ...(parentDependenciesInput.webSearchService
      ? { webSearchService: parentDependenciesInput.webSearchService }
      : {}),
    ...(parentDependenciesInput.activityOcrEnabled !== undefined
      ? { activityOcrEnabled: parentDependenciesInput.activityOcrEnabled }
      : {}),
    ...(parentDependenciesInput.sourceQueryExecutor
      ? { sourceQueryExecutor: parentDependenciesInput.sourceQueryExecutor }
      : {}),
    ...(parentDependenciesInput.sourceQueryStorage
      ? { sourceQueryStorage: parentDependenciesInput.sourceQueryStorage }
      : {}),
    ...(parentDependenciesInput.memoryService
      ? { memoryService: parentDependenciesInput.memoryService }
      : {})
  }
  return {
    profile: {
      ...input.profile,
      ...(input.profile.allowedTools ? { allowedTools: [...input.profile.allowedTools] } : {})
    },
    profileId: input.profileId,
    dependencies: {
      settings: { ...input.dependencies.settings },
      ...(input.dependencies.config ? { config: input.dependencies.config } : {}),
      ...(input.dependencies.activeSkills
        ? { activeSkills: [...input.dependencies.activeSkills] }
        : {}),
      parentToolContext: {
        workspacePath: parentToolContextInput.workspacePath,
        ...(parentToolContextInput.sandboxed !== undefined
          ? { sandboxed: parentToolContextInput.sandboxed }
          : {}),
        ...(parentToolContextInput.imageToTextService
          ? { imageToTextService: parentToolContextInput.imageToTextService }
          : {}),
        ...(parentToolContextInput.processBroker
          ? { processBroker: parentToolContextInput.processBroker }
          : {})
      },
      parentDependencies,
      createModelRuntime: input.dependencies.createModelRuntime,
      ...(input.dependencies.parentDeliveryContext
        ? { parentDeliveryContext: input.dependencies.parentDeliveryContext }
        : {}),
      ...(input.dependencies.backgroundBashContext
        ? { backgroundBashContext: input.dependencies.backgroundBashContext }
        : {})
    }
  }
}

function createWorkerRunner(
  input: WorkerRunnerFactoryInput,
  factoryInput: SubagentRunnerFactoryInput
): SubagentRunner {
  const { launch, onProgress, onToolCall, sendMessage, hasPendingMessages } = factoryInput
  const profile = input.profile
  const { settings, config, activeSkills, createModelRuntime } = input.dependencies
  const parentToolContext = {
    ...(input.dependencies.parentToolContext.sandboxed !== undefined
      ? { sandboxed: input.dependencies.parentToolContext.sandboxed }
      : {}),
    ...(input.dependencies.parentToolContext.imageToTextService
      ? { imageToTextService: input.dependencies.parentToolContext.imageToTextService }
      : {}),
    ...(input.dependencies.parentToolContext.processBroker
      ? { processBroker: input.dependencies.parentToolContext.processBroker }
      : {})
  }
  const parentDependenciesInput = input.dependencies.parentDependencies
  const parentDependencies: AgentToolDependencies = {
    ...(parentDependenciesInput.availableSkills
      ? { availableSkills: parentDependenciesInput.availableSkills }
      : {}),
    ...(parentDependenciesInput.fetchImpl ? { fetchImpl: parentDependenciesInput.fetchImpl } : {}),
    ...(parentDependenciesInput.searchService
      ? { searchService: parentDependenciesInput.searchService }
      : {}),
    ...(parentDependenciesInput.webSearchService
      ? { webSearchService: parentDependenciesInput.webSearchService }
      : {}),
    ...(parentDependenciesInput.activityOcrEnabled !== undefined
      ? { activityOcrEnabled: parentDependenciesInput.activityOcrEnabled }
      : {}),
    ...(parentDependenciesInput.sourceQueryExecutor
      ? { sourceQueryExecutor: parentDependenciesInput.sourceQueryExecutor }
      : {}),
    ...(parentDependenciesInput.sourceQueryStorage
      ? { sourceQueryStorage: parentDependenciesInput.sourceQueryStorage }
      : {}),
    ...(parentDependenciesInput.memoryService
      ? { memoryService: parentDependenciesInput.memoryService }
      : {})
  }
  const workerRunMode = input.dependencies.parentDeliveryContext?.runMode
  const profileSnapshot: WorkerProfile = {
    ...profile,
    ...(profile.allowedTools ? { allowedTools: [...profile.allowedTools] } : {})
  }
  const enabledTools = new Set<ToolCallName>(
    profileSnapshot.allowedTools ?? ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'skillsRead']
  )
  // These endpoints belong to the parent conversation and must never leak into
  // a detached Worker, even if a future profile is configured incorrectly.
  enabledTools.delete('delegateTask')
  enabledTools.delete('sendThreadMessage')

  const workerReadRecordCache = new ReadRecordCache()
  const workerSnapshotTracker: SnapshotTracker = new WorkerSnapshotTracker(
    launch.workspacePath,
    `${launch.launchRunId}:subagent:${launch.agentId}`,
    launch.parentThreadId
  )
  workerSnapshotTracker.startBaselineScan()
  const workerContext: AgentToolContext = {
    runId: `${launch.launchRunId}:subagent:${launch.agentId}`,
    threadId: launch.parentThreadId,
    workspacePath: launch.workspacePath,
    enabledTools: [...enabledTools],
    registerOnlyEnabledToolSchemas: true,
    readRecordCache: workerReadRecordCache,
    snapshotTracker: workerSnapshotTracker,
    ...(parentToolContext.processBroker ? { processBroker: parentToolContext.processBroker } : {}),
    ...(input.dependencies.backgroundBashContext?.onStarted
      ? { onBackgroundBashStarted: input.dependencies.backgroundBashContext.onStarted }
      : {}),
    ...(input.dependencies.backgroundBashContext?.onAdopted
      ? { onBackgroundBashAdopted: input.dependencies.backgroundBashContext.onAdopted }
      : {}),
    ...(parentToolContext.sandboxed !== undefined
      ? { sandboxed: parentToolContext.sandboxed }
      : {}),
    ...(parentToolContext.imageToTextService
      ? { imageToTextService: parentToolContext.imageToTextService }
      : {}),
    ...(workerRunMode ? { runMode: workerRunMode } : {})
  }
  const workerMessageContext: AgentMessageContextLike = {
    sender: { kind: 'agent', agentId: launch.agentId },
    dispatch: sendMessage
  }
  const workerDependencies = {
    availableSkills: parentDependencies.availableSkills,
    activeSkills,
    searchService: parentDependencies.searchService,
    ...(enabledTools.has('webRead') || enabledTools.has('jsRepl')
      ? { fetchImpl: parentDependencies.fetchImpl }
      : {}),
    ...(enabledTools.has('webSearch') || enabledTools.has('jsRepl')
      ? { webSearchService: parentDependencies.webSearchService }
      : {}),
    ...(enabledTools.has('querySource')
      ? {
          activityOcrEnabled: parentDependencies.activityOcrEnabled,
          sourceQueryExecutor: parentDependencies.sourceQueryExecutor,
          sourceQueryStorage: parentDependencies.sourceQueryStorage,
          memoryService: parentDependencies.memoryService
        }
      : {}),
    ...(enabledTools.has('sendMessage') ? { agentMessageContext: workerMessageContext } : {})
  } as AgentToolDependencies
  const tools = createAgentToolSet(workerContext, workerDependencies)
  const disposeTools = asToolSetDisposer(tools)
  const workerSettings = config
    ? toSubagentProviderSettings(config, launch.agentType, settings)
    : settings
  const workerSystemPrompt = buildWorkerSystemPrompt(
    profileSnapshot.systemPrompt,
    (activeSkills ?? []).map((skill) => skill.name),
    enabledTools.has('skillsRead'),
    { agentId: launch.agentId, parentThreadId: launch.parentThreadId }
  )
  const history: ModelMessage[] = [{ role: 'system', content: workerSystemPrompt }]
  if (workerSettings.provider === 'anthropic') applyAnthropicCacheBreakpoints(history)
  const historyCompactor =
    config?.chat?.stripCompact === false
      ? null
      : createWorkerHistoryCompactor({
          createModelRuntime,
          settings: workerSettings,
          systemPrompt: workerSystemPrompt,
          thresholdTokens:
            config?.chat?.stripCompactThresholdTokens ?? DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
          toolCount: Object.keys(tools ?? {}).length
        })
  let previousPromptTokens: number | undefined

  let closed = false
  let closePromise: Promise<void | { snapshotId?: string }> | undefined
  const runner: SubagentRunner = {
    async runTurn(turn: SubagentRunnerTurnInput): Promise<SubagentTurnResult> {
      if (closed) throw new Error(`Worker subagent "${launch.agentId}" is closed.`)
      const turnMessages: ModelMessage[] = []
      if (turn.initialPrompt !== undefined) {
        turnMessages.push({ role: 'user', content: turn.initialPrompt })
      }
      turnMessages.push(...turn.messages.map(mailboxMessage))
      history.push(...turnMessages)
      const compaction = historyCompactor
        ? await historyCompactor.compactIfNeeded({
            history,
            signal: turn.signal,
            previousPromptTokens
          })
        : {
            history,
            phase: undefined,
            promptTokens: 0,
            completionTokens: 0
          }
      if (compaction.history !== history) {
        history.splice(0, history.length, ...compaction.history)
        if (workerSettings.provider === 'anthropic') applyAnthropicCacheBreakpoints(history)
      }
      const modelRuntime = createModelRuntime()
      let output = ''
      let promptTokens: number | undefined
      let completionTokens: number | undefined
      let responseMessages: unknown[] | undefined
      const recentToolSummaries: string[] = []
      for await (const delta of modelRuntime.streamReply({
        messages: history,
        settings: workerSettings,
        signal: turn.signal,
        purpose: `worker:${launch.agentType}`,
        promptCacheKey: `${launch.parentThreadId}:subagent:${launch.agentId}`,
        maxToolSteps: profileSnapshot.maxToolSteps ?? 999,
        stopWhen: tools
          ? [
              stepCountIs(profileSnapshot.maxToolSteps ?? 999),
              ({ steps }) => hasPendingMessages() && (steps.at(-1)?.toolResults?.length ?? 0) > 0
            ]
          : undefined,
        tools,
        onToolCallStart: (event) => {
          const inputSummary = summarizeToolInput(event.toolCall.toolName, event.toolCall.input)
          onProgress({
            turnId: turn.turnId,
            chunk: `[${event.toolCall.toolName}] ${inputSummary}\n`
          })
          onToolCall({
            turnId: turn.turnId,
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            inputSummary,
            status: 'running'
          })
        },
        onToolCallFinish: (event) => {
          const inputSummary = summarizeToolInput(event.toolCall.toolName, event.toolCall.input)
          const outputSummary = event.success
            ? summarizeToolOutput(event.toolCall.toolName, event.output)
            : summarizeToolOutput(event.toolCall.toolName, {
                error: event.error instanceof Error ? event.error.message : String(event.error)
              })
          recentToolSummaries.push(
            `${event.toolCall.toolName}: ${inputSummary}${outputSummary ? ` → ${outputSummary}` : ''}`
          )
          onToolCall({
            turnId: turn.turnId,
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            inputSummary,
            outputSummary,
            status: event.success ? 'completed' : 'failed'
          })
        },
        onFinish: (usage) => {
          promptTokens = usage.promptTokens
          completionTokens = usage.completionTokens
          responseMessages = usage.responseMessages
        }
      })) {
        output += delta
        onProgress({ turnId: turn.turnId, chunk: delta })
      }
      previousPromptTokens = promptTokens

      if (responseMessages && responseMessages.length > 0) {
        history.push(...(responseMessages as ModelMessage[]))
      } else if (output.trim()) {
        history.push({ role: 'assistant', content: output })
      }
      const finalOutput = output.trim()
        ? output
        : recentToolSummaries.length > 0
          ? `Subagent completed without a final text response. Recent tool calls:\n${recentToolSummaries.map((summary) => `- ${summary}`).join('\n')}`
          : ''
      const totalPromptTokens = (promptTokens ?? 0) + compaction.promptTokens
      const totalCompletionTokens = (completionTokens ?? 0) + compaction.completionTokens
      return {
        output: finalOutput,
        ...(promptTokens !== undefined || compaction.phase
          ? { promptTokens: totalPromptTokens }
          : {}),
        ...(completionTokens !== undefined || compaction.phase
          ? { completionTokens: totalCompletionTokens }
          : {})
      }
    },
    async close(): Promise<void | { snapshotId?: string }> {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        try {
          await workerSnapshotTracker.finalize()
          return { snapshotId: `${launch.agentId}:snapshot` }
        } finally {
          workerSnapshotTracker.dispose()
          await disposeTools()
        }
      })()
      return closePromise
    }
  }
  return runner
}

export function createWorkerSubagentRunnerFactory(
  input: WorkerRunnerFactoryInput
): SubagentRunnerFactory {
  const sanitizedInput = sanitizeWorkerRunnerInput(input)
  return (factoryInput) => createWorkerRunner(sanitizedInput, factoryInput)
}
