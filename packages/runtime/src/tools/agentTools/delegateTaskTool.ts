import { tool, type Tool } from 'ai'
import { access as fsAccess } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import type {
  NamedSubagentId,
  ProviderSettings,
  SettingsConfig,
  SkillSummary,
  SubagentProfile,
  SubagentsConfig,
  ToolCallName
} from '@yachiyo/shared/protocol'
import { summarizeToolInput, summarizeToolOutput } from '../agentTools.ts'
import { launchAcpProcess } from '../../runtime/acp/acpLauncher.ts'
import { createAcpStreamAdapter } from '../../runtime/acp/acpStreamAdapter.ts'
import { runAcpSession } from '../../runtime/acp/acpSessionClient.ts'
import { applyAnthropicCacheBreakpoints } from '../../runtime/context/contextLayers.ts'
import type { ModelRuntime, ModelMessage } from '../../runtime/models/types.ts'
import {
  DEFAULT_NAMED_SUBAGENT_PROFILES,
  SUBAGENT_DESCRIPTIONS,
  WORKER_DELEGATION_PROMPT_GUIDANCE
} from '../../settings/namedSubagents.ts'
import { toSubagentProviderSettings } from '../../settings/settingsStore.ts'
import { createAgentToolSet, type AgentToolDependencies } from '../agentTools.ts'
import { toToolModelOutput, type AgentToolContext } from './shared.ts'

/** Gojūon-order meaningful Japanese romaji code names for subagents. */
const SUBAGENT_CODE_NAMES = [
  // あ行 (A)
  'Akari', // 明かり — lamplight
  'Ibuki', // 息吹 — breath of life
  'Ukiyo', // 浮世 — floating world
  'Enishi', // 縁 — bond / fate
  'Ochiba', // 落葉 — fallen leaves

  // か行 (Ka)
  'Kagerou', // 陽炎 — heat haze
  'Kikyou', // 桔梗 — bellflower
  'Kurenai', // 紅 — deep crimson
  'Kemuri', // 煙 — smoke
  'Komorebi', // 木漏れ日 — sunlight through leaves

  // さ行 (Sa)
  'Sakura', // 桜 — cherry blossom
  'Shigure', // 時雨 — late-autumn rain
  'Susuki', // 薄 — pampas grass
  'Setsuna', // 刹那 — moment / instant
  'Soyokaze', // そよ風 — gentle breeze

  // た行 (Ta)
  'Tamayura', // 玉響 — brief moment
  'Chigusa', // 千草 — myriad grasses
  'Tsurara', // 氷柱 — icicle
  'Tegami', // 手紙 — letter
  'Tomoshibi', // 灯火 — lamplight

  // な行 (Na)
  'Nagisa', // 渚 — shore
  'Nioi', // 匂い — scent / fragrance
  'Nukumori', // 温もり — warmth
  'Negai', // 願い — wish
  'Nogiku', // 野菊 — wild chrysanthemum

  // は行 (Ha)
  'Hanabi', // 花火 — fireworks
  'Hikari', // 光 — light
  'Fubuki', // 吹雪 — blizzard
  'Henro', // 遍路 — pilgrimage
  'Hotaru', // 蛍 — firefly

  // ま行 (Ma)
  'Madobe', // 窓辺 — windowsill
  'Minamo', // 水面 — water surface
  'Murasaki', // 紫 — purple
  'Mebae', // 芽生え — sprout / budding
  'Momiji', // 紅葉 — autumn leaves

  // や行 (Ya)
  'Yamabiko', // 山彦 — mountain echo
  'Yugure', // 夕暮れ — dusk
  'Yoake', // 夜明け — dawn

  // ら行 (Ra)
  'Raimei', // 雷鳴 — thunder
  'Rikka', // 立夏 — first day of summer
  'Ruri', // 瑠璃 — lapis lazuli
  'Reimei', // 黎明 — daybreak
  'Roji', // 路地 — alley

  // わ行 (Wa)
  'Wakare' // 別れ — farewell
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
  config?: SettingsConfig
  /** Active (enabled) skills the worker may discover and read via skillsRead. */
  activeSkills?: SkillSummary[]
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

/**
 * Worker subagents only see their static profile system prompt — unlike the main
 * agent, they never get a dynamically injected skill catalog. When the worker can
 * read Skills, append just the active-skill names so it can discover what exists.
 * How to use them is already covered by the skillsRead tool description, so we do
 * not restate that here.
 */
function buildWorkerSystemPrompt(
  baseSystemPrompt: string,
  activeSkillNames: string[],
  hasSkillsRead: boolean
): string {
  if (!hasSkillsRead || activeSkillNames.length === 0) {
    return baseSystemPrompt
  }
  return `${baseSystemPrompt}\n\nActive Skills: ${activeSkillNames.join(', ')}.`
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
  const workerSettings =
    ctx.config && ctx.settings
      ? toSubagentProviderSettings(ctx.config, profileId, ctx.settings)
      : ctx.settings
  const messages: ModelMessage[] = [
    {
      role: 'system' as const,
      content: buildWorkerSystemPrompt(
        profile.systemPrompt,
        (ctx.activeSkills ?? []).map((skill) => skill.name),
        workerEnabledTools.has('skillsRead')
      )
    },
    { role: 'user' as const, content: prompt }
  ]
  if (workerSettings.provider === 'anthropic') {
    applyAnthropicCacheBreakpoints(messages)
  }
  const promptCacheKey = ctx.parentToolContext.threadId
    ? `${ctx.parentToolContext.threadId}:subagent:${profileId}`
    : undefined

  let resultText = ''
  const recentToolSummaries: string[] = []

  let promptTokens: number | undefined
  let completionTokens: number | undefined

  try {
    for await (const delta of modelRuntime.streamReply({
      messages,
      settings: workerSettings,
      signal: abortSignal ?? new AbortController().signal,
      purpose: `worker:${profileId}`,
      ...(promptCacheKey ? { promptCacheKey } : {}),
      maxToolSteps: profile.maxToolSteps ?? 999,
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
    'Prompt guidance:',
    ...WORKER_DELEGATION_PROMPT_GUIDANCE.map((item) => `- ${item}`)
  ].join('\n')
  const inputSchema = workerDelegateTaskBaseSchema.extend({
    agent_name: z.enum(enabledAgents as [NamedSubagentId, ...NamedSubagentId[]])
  })
  return tool({
    description,
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
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
    toModelOutput: ({ output }) => toToolModelOutput(output),
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
