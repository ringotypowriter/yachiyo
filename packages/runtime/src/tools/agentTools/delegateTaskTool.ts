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
  SubagentToolCallDetails,
  SubagentsConfig
} from '@yachiyo/shared/protocol'
import { launchAcpProcess } from '../../runtime/acp/acpLauncher.ts'
import { createAcpStreamAdapter } from '../../runtime/acp/acpStreamAdapter.ts'
import { runAcpSession } from '../../runtime/acp/acpSessionClient.ts'
import {
  DEFAULT_NAMED_SUBAGENT_PROFILES,
  SUBAGENT_DESCRIPTIONS,
  WORKER_DELEGATION_PROMPT_GUIDANCE
} from '../../settings/namedSubagents.ts'
import type { AgentToolDependencies } from '../agentTools.ts'
import type {
  SubagentManager,
  SubagentParentDeliveryContext
} from '../../app/domain/subagents/subagentManager.ts'
import {
  createWorkerSubagentRunnerFactory,
  type WorkerSubagentRunnerDependencies
} from '../../app/domain/subagents/workerSubagentRunner.ts'
import { toToolModelOutput, type AgentToolContext } from './shared.ts'
import type { ModelRuntime } from '../../runtime/models/types.ts'

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
  details?: SubagentToolCallDetails
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
  subagentManager?: SubagentManager
  parentDeliveryContext?: SubagentParentDeliveryContext
  backgroundBashContext?: AgentToolDependencies['backgroundBashContext']
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
    execute: async (input, options): Promise<DelegateTaskOutput> => {
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
      if (!ctx.subagentManager) {
        const error = 'Worker subagent manager is unavailable.'
        return { content: [{ type: 'text', text: error }], error }
      }
      const parentThreadId = ctx.parentToolContext.threadId
      if (!parentThreadId) {
        const error = 'Worker delegation requires a parent thread ID.'
        return { content: [{ type: 'text', text: error }], error }
      }

      const profile = DEFAULT_NAMED_SUBAGENT_PROFILES[agentName]
      const codeName = assignCodeName()

      const parentDeliveryContext =
        ctx.parentDeliveryContext ??
        (
          ctx.parentDependencies as AgentToolDependencies & {
            parentDeliveryContext?: SubagentParentDeliveryContext
          }
        ).parentDeliveryContext
      const parentBackgroundBashContext = ctx.backgroundBashContext
      const backgroundBashContext = parentBackgroundBashContext
        ? {
            ...(parentBackgroundBashContext.onStarted
              ? {
                  onStarted: async (
                    task: Parameters<NonNullable<typeof parentBackgroundBashContext.onStarted>>[0]
                  ) =>
                    parentBackgroundBashContext.onStarted?.({
                      ...task,
                      ownerAgentId: delegationId
                    })
                }
              : {}),
            ...(parentBackgroundBashContext.onAdopted
              ? {
                  onAdopted: async (
                    task: Parameters<NonNullable<typeof parentBackgroundBashContext.onAdopted>>[0]
                  ) =>
                    parentBackgroundBashContext.onAdopted?.({
                      ...task,
                      ownerAgentId: delegationId
                    })
                }
              : {})
          }
        : undefined
      const runnerDependencies: WorkerSubagentRunnerDependencies = {
        settings: { ...ctx.settings },
        ...(ctx.config ? { config: ctx.config } : {}),
        ...(ctx.activeSkills ? { activeSkills: [...ctx.activeSkills] } : {}),
        parentToolContext: { ...ctx.parentToolContext, workspacePath: workspaceResult },
        parentDependencies: ctx.parentDependencies,
        createModelRuntime: ctx.createModelRuntime,
        ...(parentDeliveryContext ? { parentDeliveryContext } : {}),
        ...(backgroundBashContext ? { backgroundBashContext } : {})
      }
      const runnerFactory = createWorkerSubagentRunnerFactory({
        profileId: agentName,
        profile,
        dependencies: runnerDependencies
      })

      try {
        const receipt = await ctx.subagentManager.launch({
          agentId: delegationId,
          parentThreadId,
          launchRunId: ctx.parentToolContext.runId ?? delegationId,
          agentName,
          agentType: agentName,
          codeName,
          workspacePath: workspaceResult,
          prompt: input.prompt,
          ...(parentDeliveryContext ? { parentDeliveryContext } : {}),
          runnerFactory
        })
        const text =
          `Worker ${agentName} (${receipt.codeName}) launched as Agent ${receipt.agentId} in ${receipt.workspacePath}. ` +
          'The initial result will be delivered automatically. After finishing a turn, the Agent remains idle and retains its history until closed or expired. ' +
          `Use sendMessage with to "${receipt.agentId}" to add related work or wake this same Agent; launch another Worker only for independent work.`
        const details: SubagentToolCallDetails = {
          kind: 'subagent',
          agentId: receipt.agentId,
          agentName,
          agentType: agentName,
          codeName: receipt.codeName,
          workspacePath: receipt.workspacePath,
          lifecycleState: receipt.state,
          snapshotId: receipt.agentId
        }
        return { content: [{ type: 'text', text }], details }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Worker delegation failed: ${detail}` }],
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
