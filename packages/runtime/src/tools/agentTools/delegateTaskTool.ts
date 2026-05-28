import { tool, type Tool } from 'ai'
import { access as fsAccess } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import type {
  NamedSubagentId,
  ProviderSettings,
  SubagentProfile,
  SubagentsConfig,
  ToolCallName
} from '@yachiyo/shared/protocol'
import { summarizeToolInput, summarizeToolOutput } from '../agentTools.ts'
import { launchAcpProcess } from '../../runtime/acp/acpLauncher.ts'
import { createAcpStreamAdapter } from '../../runtime/acp/acpStreamAdapter.ts'
import { runAcpSession } from '../../runtime/acp/acpSessionClient.ts'
import type { ModelRuntime } from '../../runtime/models/types.ts'
import {
  DEFAULT_NAMED_SUBAGENT_PROFILES,
  SUBAGENT_DESCRIPTIONS
} from '../../settings/namedSubagents.ts'
import { createAgentToolSet, type AgentToolDependencies } from '../agentTools.ts'
import type { AgentToolContext } from './shared.ts'

/** Gojūon-order meaningful Japanese romaji code names for subagents. */
const SUBAGENT_CODE_NAMES = [
  'Ame', // 雨 — rain
  'Kaze', // 風 — wind
  'Sora', // 空 — sky
  'Tsuki', // 月 — moon
  'Hana', // 花 — flower
  'Mizu', // 水 — water
  'Yama', // 山 — mountain
  'Ringo', // 林檎 — apple
  'Kumo', // 雲 — cloud
  'Tori', // 鳥 — bird
  'Hoshi', // 星 — star
  'Umi', // 海 — sea
  'Yuki', // 雪 — snow
  'Sakura', // 桜 — cherry blossom
  'Hikari', // 光 — light
  'Kawa', // 川 — river
  'Mori', // 森 — forest
  'Tsubasa', // 翼 — wing
  'Asa', // 朝 — morning
  'Yoru', // 夜 — night
  'Natsu', // 夏 — summer
  'Aki', // 秋 — autumn
  'Fuyu', // 冬 — winter
  'Haruka', // 遥 — distant
  'Sui' // 翠 — jade green
]

let codeNameIndex = 0
function assignCodeName(): string {
  const name = SUBAGENT_CODE_NAMES[codeNameIndex % SUBAGENT_CODE_NAMES.length]!
  codeNameIndex++
  return name
}

const VALID_NAMED_SUBAGENT_IDS: NamedSubagentId[] = ['explore', 'plan', 'review', 'general']

const workerDelegateTaskBaseSchema = z.object({
  prompt: z.string().min(1),
  workspace: z
    .string()
    .optional()
    .describe(
      'Optional workspace path. Must be one of the available workspaces listed in the subagents context. Defaults to the current thread workspace.'
    )
})

const acpDelegateTaskInputSchema = z.object({
  agent_name: z.string().min(1),
  prompt: z.string().min(1),
  workspace: z
    .string()
    .optional()
    .describe(
      'Optional workspace path. Must be one of the available workspaces listed in the subagents context. Defaults to the current thread workspace.'
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      'Optional session ID to resume a previous delegated task. Only pass this when the user explicitly asks to resume and you have the exact ID from a prior result. Never invent a session ID.'
    )
})

interface WorkerDelegateTaskInput {
  agent_name: NamedSubagentId
  prompt: string
  workspace?: string
}
type AcpDelegateTaskInput = z.infer<typeof acpDelegateTaskInputSchema>
type DelegateTaskInput = WorkerDelegateTaskInput | AcpDelegateTaskInput

interface DelegateTaskOutput {
  content: Array<{ type: 'text'; text: string }>
  sessionId?: string
  error?: string
}

export interface DelegateTaskStartedEvent {
  delegationId: string
  agentName: string
  agentType: NamedSubagentId | string
  workspacePath: string
  startedAt: string
  prompt?: string
  codeName?: string
}

export interface DelegateTaskProgressEvent {
  delegationId: string
  chunk: string
}

export interface DelegateTaskFinishedEvent {
  delegationId: string
  agentName: string
  agentType: NamedSubagentId | string
  status: 'success' | 'cancelled'
  lastMessage?: string
  sessionId?: string
  workspacePath: string
  durationMs?: number
  promptTokens?: number
  completionTokens?: number
  codeName?: string
}

export interface DelegateTaskToolCallEvent {
  delegationId: string
  toolCallId?: string
  toolName: string
  inputSummary: string
  outputSummary?: string
  status?: 'running' | 'completed' | 'failed'
}

export interface DelegateTaskContext {
  workspacePath: string
  availableWorkspaces: string[]
  subagentsConfig: SubagentsConfig
  subagentProfiles: SubagentProfile[]
  settings: ProviderSettings
  createModelRuntime: () => ModelRuntime
  parentToolContext: AgentToolContext
  parentDependencies: AgentToolDependencies
  onProgress?: (event: DelegateTaskProgressEvent) => void
  onSubagentStarted?: (event: DelegateTaskStartedEvent) => void
  onSubagentFinished?: (event: DelegateTaskFinishedEvent) => void
  onSubagentToolCall?: (event: DelegateTaskToolCallEvent) => void
  launchAcpProcess?: typeof launchAcpProcess
  runAcpSession?: typeof runAcpSession
}

const ACP_SYSTEM_INSTRUCTION =
  "CRITICAL: The subagent has finished its execution. Before replying to the user, you MUST use your `read`, `bash` (e.g., git status, git diff), or `grep` tools to verify the actual file changes. Do not blindly trust the agent's summary. Once verified, report your findings to the user."

async function resolveWorkspace(input: {
  requestedWorkspace?: string
  ctx: DelegateTaskContext
  requireGit: boolean
}): Promise<string | { error: string }> {
  if (!input.requestedWorkspace) {
    const workspacePath = resolve(input.ctx.workspacePath)
    if (input.requireGit) {
      const hasGit = await fsAccess(join(workspacePath, '.git'))
        .then(() => true)
        .catch(() => false)
      if (!hasGit) {
        return {
          error: `Workspace "${workspacePath}" is not a Git repository. A Git repository is required for safe ACP execution.`
        }
      }
    }
    return workspacePath
  }

  const requested = resolve(input.requestedWorkspace)
  const allowed = input.ctx.availableWorkspaces.map((p) => resolve(p))
  if (!allowed.includes(requested)) {
    return {
      error: `Workspace "${input.requestedWorkspace}" is not in the allowed workspace list. Available: ${input.ctx.availableWorkspaces.join(', ')}`
    }
  }

  const exists = await fsAccess(requested)
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    return { error: `Workspace directory does not exist: "${requested}".` }
  }

  if (input.requireGit) {
    const hasGit = await fsAccess(join(requested, '.git'))
      .then(() => true)
      .catch(() => false)
    if (!hasGit) {
      return {
        error: `Workspace "${requested}" is not a Git repository. A Git repository is required for safe ACP execution.`
      }
    }
  }

  return requested
}

async function runWorkerSubagent(
  profileId: NamedSubagentId,
  prompt: string,
  ctx: DelegateTaskContext,
  delegationId: string,
  abortSignal?: AbortSignal
): Promise<
  DelegateTaskOutput & {
    lastMessage: string
    durationMs: number
    promptTokens?: number
    completionTokens?: number
  }
> {
  const profile = DEFAULT_NAMED_SUBAGENT_PROFILES[profileId]
  if (!ctx.subagentsConfig.enabledNamedAgents.includes(profileId)) {
    const error = `Worker subagent "${profileId}" is not enabled.`
    return { content: [{ type: 'text', text: error }], error, lastMessage: error, durationMs: 0 }
  }

  const startedAt = Date.now()
  const modelRuntime = ctx.createModelRuntime()
  const workerEnabledTools = new Set<ToolCallName>(
    profile.allowedTools ?? ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'skillsRead']
  )
  const workerContext: AgentToolContext = {
    ...ctx.parentToolContext,
    enabledTools: [...workerEnabledTools],
    registerOnlyEnabledToolSchemas: true
  }
  const workerDeps: AgentToolDependencies = {
    availableSkills: ctx.parentDependencies.availableSkills,
    searchService: ctx.parentDependencies.searchService,
    ...(workerEnabledTools.has('webRead') || workerEnabledTools.has('jsRepl')
      ? { fetchImpl: ctx.parentDependencies.fetchImpl }
      : {}),
    ...(workerEnabledTools.has('webSearch') || workerEnabledTools.has('jsRepl')
      ? { webSearchService: ctx.parentDependencies.webSearchService }
      : {}),
    ...(workerEnabledTools.has('querySource')
      ? {
          activityOcrEnabled: ctx.parentDependencies.activityOcrEnabled,
          sourceQueryExecutor: ctx.parentDependencies.sourceQueryExecutor,
          sourceQueryStorage: ctx.parentDependencies.sourceQueryStorage,
          memoryService: ctx.parentDependencies.memoryService
        }
      : {})
  }
  const tools = createAgentToolSet(workerContext, workerDeps)
  const messages = [
    { role: 'system' as const, content: profile.systemPrompt },
    { role: 'user' as const, content: prompt }
  ]
  let resultText = ''
  const recentToolSummaries: string[] = []

  let promptTokens: number | undefined
  let completionTokens: number | undefined

  try {
    for await (const delta of modelRuntime.streamReply({
      messages,
      settings: ctx.settings,
      signal: abortSignal ?? new AbortController().signal,
      purpose: `worker:${profileId}`,
      maxToolSteps: profile.maxToolSteps ?? 10,
      tools,
      onToolCallStart: (event) => {
        const toolName = event.toolCall.toolName
        const inputSummary = summarizeToolInput(toolName, event.toolCall.input)
        ctx.onProgress?.({ delegationId, chunk: `[${toolName}] ${inputSummary}\n` })
        ctx.onSubagentToolCall?.({
          delegationId,
          toolCallId: event.toolCall.toolCallId,
          toolName,
          inputSummary,
          status: 'running'
        })
      },
      onToolCallFinish: (event) => {
        const toolName = event.toolCall.toolName
        const inputSummary = summarizeToolInput(toolName, event.toolCall.input)
        const outputSummary = event.success
          ? summarizeToolOutput(toolName, event.output)
          : summarizeToolOutput(toolName, {
              error: event.error instanceof Error ? event.error.message : String(event.error)
            })
        recentToolSummaries.push(
          `${toolName}: ${inputSummary}${outputSummary ? ` → ${outputSummary}` : ''}`
        )
        if (recentToolSummaries.length > 5) recentToolSummaries.shift()
        ctx.onSubagentToolCall?.({
          delegationId,
          toolCallId: event.toolCall.toolCallId,
          toolName,
          inputSummary,
          outputSummary,
          status: event.success ? 'completed' : 'failed'
        })
      },
      onFinish: (usage) => {
        promptTokens = usage.promptTokens
        completionTokens = usage.completionTokens
      }
    })) {
      resultText += delta
      ctx.onProgress?.({ delegationId, chunk: delta })
    }
  } catch (err) {
    if (abortSignal?.aborted) {
      const abortErr = new Error('Worker subagent aborted.', { cause: err })
      abortErr.name = 'AbortError'
      throw abortErr
    }
    const detail = err instanceof Error ? err.message : String(err)
    resultText += `\n\n[Worker subagent error: ${detail}]`
  }

  const finalText = resultText.trim()
  if (!finalText) {
    resultText =
      recentToolSummaries.length > 0
        ? `Subagent completed without a final text response. Recent tool calls:\n${recentToolSummaries.map((summary) => `- ${summary}`).join('\n')}`
        : 'Subagent completed without a final text response.'
  }

  const durationMs = Date.now() - startedAt
  return {
    content: [{ type: 'text', text: resultText }],
    lastMessage: resultText,
    durationMs,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {})
  }
}

async function runAcpSubagent(
  profile: SubagentProfile,
  prompt: string,
  ctx: DelegateTaskContext,
  delegationId: string,
  abortSignal?: AbortSignal,
  resumeSessionId?: string
): Promise<DelegateTaskOutput & { lastMessage: string }> {
  const adapter = createAcpStreamAdapter({
    onProgress: (chunk) => ctx.onProgress?.({ delegationId, chunk })
  })
  const startAcpProcess = ctx.launchAcpProcess ?? launchAcpProcess
  const executeAcpSession = ctx.runAcpSession ?? runAcpSession
  const { proc, stream, procExited } = startAcpProcess(profile, ctx.workspacePath)
  const adapterRef = { current: adapter }

  proc.stderr?.on('data', (chunk: Buffer) => {
    adapterRef.current.onStderr(chunk)
  })

  const { sessionId, stopReason, lastMessageText } = await executeAcpSession(
    stream,
    proc,
    procExited,
    ctx.workspacePath,
    [{ type: 'text', text: prompt }],
    adapter,
    adapterRef,
    { abortSignal, resumeSessionId }
  )

  const agentLastMessage = lastMessageText.trim() || '(no output)'
  const sessionLine = `Session ID: ${sessionId}`
  const text =
    stopReason === 'cancelled'
      ? `${sessionLine}\n\nAgent was cancelled before completing.\n\n${ACP_SYSTEM_INSTRUCTION}`
      : `${sessionLine}\n\n${agentLastMessage}\n\n${ACP_SYSTEM_INSTRUCTION}`

  return {
    content: [{ type: 'text', text }],
    sessionId,
    lastMessage: agentLastMessage
  }
}

function createWorkerTool(
  ctx: DelegateTaskContext
): Tool<WorkerDelegateTaskInput, DelegateTaskOutput> {
  const enabledAgents = VALID_NAMED_SUBAGENT_IDS.filter((id) =>
    ctx.subagentsConfig.enabledNamedAgents.includes(id)
  )
  const agentLines = enabledAgents.map((id) => `- ${id}: ${SUBAGENT_DESCRIPTIONS[id]}`)
  const description = [
    'Delegate a task to a specialized worker subagent.',
    '',
    'Choose the agent_name that matches the task:',
    ...agentLines,
    '',
    'Write the prompt as a clear, direct task description. Include the objective, relevant context, and what done looks like.'
  ].join('\n')
  const inputSchema = workerDelegateTaskBaseSchema.extend({
    agent_name: z.enum(enabledAgents as [NamedSubagentId, ...NamedSubagentId[]])
  })
  return tool({
    description,
    inputSchema,
    toModelOutput: ({ output }) => ({ type: 'content', value: output.content }),
    execute: async (input, options) => {
      const delegationId = options.toolCallId
      const workspaceResult = await resolveWorkspace({
        requestedWorkspace: input.workspace,
        ctx,
        requireGit: false
      })
      if (typeof workspaceResult !== 'string') {
        return {
          content: [{ type: 'text', text: workspaceResult.error }],
          error: workspaceResult.error
        }
      }

      const agentName = input.agent_name
      if (!VALID_NAMED_SUBAGENT_IDS.includes(agentName)) {
        const error = `Unknown worker subagent "${agentName}". Valid names: ${VALID_NAMED_SUBAGENT_IDS.join(', ')}.`
        return { content: [{ type: 'text', text: error }], error }
      }
      const codeName = assignCodeName()
      const startedAt = new Date().toISOString()
      ctx.onSubagentStarted?.({
        delegationId,
        agentName,
        agentType: agentName,
        workspacePath: workspaceResult,
        startedAt,
        prompt: input.prompt,
        codeName
      })
      ctx.onProgress?.({
        delegationId,
        chunk: `[${codeName}] > ${input.prompt}\n${'─'.repeat(40)}\n`
      })

      try {
        const { durationMs, promptTokens, completionTokens, lastMessage, ...result } =
          await runWorkerSubagent(
            agentName,
            input.prompt,
            { ...ctx, workspacePath: workspaceResult },
            delegationId,
            options.abortSignal
          )
        ctx.onSubagentFinished?.({
          delegationId,
          agentName,
          agentType: agentName,
          status: 'success',
          lastMessage,
          workspacePath: workspaceResult,
          durationMs,
          promptTokens,
          completionTokens,
          codeName
        })
        return result
      } catch (err) {
        if (options.abortSignal?.aborted) {
          const abortErr = new Error('Subagent execution aborted.', { cause: err })
          abortErr.name = 'AbortError'
          throw abortErr
        }
        const detail = err instanceof Error ? err.message : 'Subagent execution failed.'
        ctx.onSubagentFinished?.({
          delegationId,
          agentName,
          agentType: agentName,
          status: 'cancelled',
          workspacePath: workspaceResult,
          codeName
        })
        return {
          content: [{ type: 'text', text: `Subagent execution failed: ${detail}` }],
          error: detail
        }
      }
    }
  })
}

function createAcpTool(ctx: DelegateTaskContext): Tool<AcpDelegateTaskInput, DelegateTaskOutput> {
  return tool({
    description: 'Delegate a task to an external agent process.',
    inputSchema: acpDelegateTaskInputSchema,
    toModelOutput: ({ output }) => ({ type: 'content', value: output.content }),
    execute: async (input, options) => {
      const delegationId = options.toolCallId
      const profile = ctx.subagentProfiles.find((p) => p.name === input.agent_name && p.enabled)
      if (!profile) {
        const error = `No enabled ACP agent profile found with name "${input.agent_name}".`
        return { content: [{ type: 'text', text: error }], error }
      }

      const workspaceResult = await resolveWorkspace({
        requestedWorkspace: input.workspace,
        ctx,
        requireGit: true
      })
      if (typeof workspaceResult !== 'string') {
        return {
          content: [{ type: 'text', text: workspaceResult.error }],
          error: workspaceResult.error
        }
      }

      const codeName = assignCodeName()
      const startedAt = new Date().toISOString()
      const acpStartedAt = Date.now()
      ctx.onSubagentStarted?.({
        delegationId,
        agentName: input.agent_name,
        agentType: 'acp',
        workspacePath: workspaceResult,
        startedAt,
        prompt: input.prompt,
        codeName
      })
      ctx.onProgress?.({
        delegationId,
        chunk: `[${codeName}] > ${input.prompt}\n${'─'.repeat(40)}\n`
      })

      try {
        const { lastMessage, ...result } = await runAcpSubagent(
          profile,
          input.prompt,
          { ...ctx, workspacePath: workspaceResult },
          delegationId,
          options.abortSignal,
          input.session_id || undefined
        )
        const durationMs = Date.now() - acpStartedAt
        ctx.onSubagentFinished?.({
          delegationId,
          agentName: input.agent_name,
          agentType: 'acp',
          status: 'success',
          lastMessage,
          sessionId: result.sessionId,
          workspacePath: workspaceResult,
          durationMs,
          codeName
        })
        return result
      } catch (err) {
        ctx.onSubagentFinished?.({
          delegationId,
          agentName: input.agent_name,
          agentType: 'acp',
          status: 'cancelled',
          workspacePath: workspaceResult,
          codeName
        })
        if (options.abortSignal?.aborted) {
          const abortErr = new Error('Subagent execution aborted.', { cause: err })
          abortErr.name = 'AbortError'
          throw abortErr
        }
        const detail = err instanceof Error ? err.message : 'Subagent execution failed.'
        const text = `Subagent execution failed: ${detail}\n\n${ACP_SYSTEM_INSTRUCTION}`
        return { content: [{ type: 'text', text }], error: detail }
      }
    }
  })
}

export function createTool(ctx: DelegateTaskContext): Tool<DelegateTaskInput, DelegateTaskOutput> {
  return ctx.subagentsConfig.mode === 'acp'
    ? (createAcpTool(ctx) as Tool<DelegateTaskInput, DelegateTaskOutput>)
    : (createWorkerTool(ctx) as Tool<DelegateTaskInput, DelegateTaskOutput>)
}
