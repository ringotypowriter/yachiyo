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
): Promise<DelegateTaskOutput & { lastMessage: string; durationMs: number }> {
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

  try {
    for await (const delta of modelRuntime.streamReply({
      messages,
      settings: ctx.settings,
      signal: abortSignal ?? new AbortController().signal,
      purpose: `worker:${profileId}`,
      maxToolSteps: profile.maxToolSteps ?? 10,
      tools,
      onToolCallStart: (event) => {
        ctx.onProgress?.({ delegationId, chunk: `[${event.toolCall.toolName}]\n` })
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

  const durationMs = Date.now() - startedAt
  return {
    content: [{ type: 'text', text: resultText }],
    lastMessage: resultText,
    durationMs
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
      const startedAt = new Date().toISOString()
      ctx.onSubagentStarted?.({
        delegationId,
        agentName,
        agentType: agentName,
        workspacePath: workspaceResult,
        startedAt
      })
      ctx.onProgress?.({ delegationId, chunk: `> ${input.prompt}\n${'─'.repeat(40)}\n` })

      try {
        const { durationMs, lastMessage, ...result } = await runWorkerSubagent(
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
          workspacePath: workspaceResult
        })
        return {
          ...result,
          content: [
            {
              type: 'text',
              text: `${result.content[0]?.text ?? ''}\n\n(duration: ${durationMs}ms)`
            }
          ]
        }
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
          workspacePath: workspaceResult
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

      const startedAt = new Date().toISOString()
      ctx.onSubagentStarted?.({
        delegationId,
        agentName: input.agent_name,
        agentType: 'acp',
        workspacePath: workspaceResult,
        startedAt
      })
      ctx.onProgress?.({ delegationId, chunk: `> ${input.prompt}\n${'─'.repeat(40)}\n` })

      try {
        const { lastMessage, ...result } = await runAcpSubagent(
          profile,
          input.prompt,
          { ...ctx, workspacePath: workspaceResult },
          delegationId,
          options.abortSignal,
          input.session_id || undefined
        )
        ctx.onSubagentFinished?.({
          delegationId,
          agentName: input.agent_name,
          agentType: 'acp',
          status: 'success',
          lastMessage,
          sessionId: result.sessionId,
          workspacePath: workspaceResult
        })
        return result
      } catch (err) {
        ctx.onSubagentFinished?.({
          delegationId,
          agentName: input.agent_name,
          agentType: 'acp',
          status: 'cancelled',
          workspacePath: workspaceResult
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
