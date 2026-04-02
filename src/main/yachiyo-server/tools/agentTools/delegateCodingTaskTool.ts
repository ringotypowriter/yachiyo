import { tool, type Tool } from 'ai'
import { access as fsAccess } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import type { SubagentProfile } from '../../../../shared/yachiyo/protocol.ts'
import { isAbortError } from '../../app/domain/shared.ts'
import { launchAcpProcess } from '../../runtime/acp/acpLauncher.ts'
import { createAcpStreamAdapter } from '../../runtime/acp/acpStreamAdapter.ts'
import { runAcpSession } from '../../runtime/acp/acpSessionClient.ts'

const delegateCodingTaskInputSchema = z.object({
  agent_name: z.string().min(1),
  prompt: z.string().min(1),
  workspace: z
    .string()
    .optional()
    .describe(
      'Optional workspace path for the coding agent to operate in. Must be one of the listed available workspaces. If omitted, the agent runs in the current thread workspace.'
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      'Optional ACP session ID for resuming the exact same delegated task. Use this field only when the user explicitly asks to continue or resume the same subagent session and you have the exact session ID from a previous delegateCodingTask tool result in the current context. If this is a new task, if the user did not explicitly ask to resume, or if you do not have that exact session ID, omit this field. Never invent, guess, infer, or transform a session ID.'
    )
})

type DelegateCodingTaskInput = z.infer<typeof delegateCodingTaskInputSchema>

interface DelegateCodingTaskOutput {
  content: Array<{ type: 'text'; text: string }>
  sessionId?: string
  error?: string
}

export interface DelegateCodingTaskContext {
  workspacePath: string
  availableWorkspaces: string[]
  profiles: SubagentProfile[]
  onProgress?: (chunk: string) => void
  onSubagentStarted?: (agentName: string) => void
  onSubagentFinished?: (
    agentName: string,
    status: 'success' | 'cancelled',
    lastMessage?: string,
    sessionId?: string,
    workspacePath?: string
  ) => void
  launchAcpProcess?: typeof launchAcpProcess
  runAcpSession?: typeof runAcpSession
}

const SYSTEM_INSTRUCTION =
  "CRITICAL: The subagent has finished its execution. Before replying to the user, you MUST use your `read`, `bash` (e.g., git status, git diff), or `grep` tools to verify the actual file changes. Do not blindly trust the agent's summary. Once verified, report your findings to the user."

async function runSubagent(
  profile: SubagentProfile,
  prompt: string,
  ctx: DelegateCodingTaskContext,
  abortSignal?: AbortSignal,
  resumeSessionId?: string
): Promise<DelegateCodingTaskOutput & { lastMessage: string }> {
  const adapter = createAcpStreamAdapter({ onProgress: ctx.onProgress })
  const startAcpProcess = ctx.launchAcpProcess ?? launchAcpProcess
  const executeAcpSession = ctx.runAcpSession ?? runAcpSession
  const { proc, stream, procExited } = startAcpProcess(profile, ctx.workspacePath)
  const adapterRef = { current: adapter }

  proc.stderr?.on('data', (chunk: Buffer) => adapterRef.current.onStderr(chunk))

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
      ? `${sessionLine}\n\nAgent was cancelled before completing.\n\n${SYSTEM_INSTRUCTION}`
      : `${sessionLine}\n\n${agentLastMessage}\n\n${SYSTEM_INSTRUCTION}`

  return {
    content: [{ type: 'text', text }],
    sessionId,
    lastMessage: agentLastMessage
  }
}

export function createTool(
  ctx: DelegateCodingTaskContext
): Tool<DelegateCodingTaskInput, DelegateCodingTaskOutput> {
  return tool({
    description:
      "Delegate a coding task to an external Coding Agent via ACP. Yachiyo will suspend until the agent finishes and returns a summary. After this tool completes, you MUST verify the agent's changes before reporting to the user.",
    inputSchema: delegateCodingTaskInputSchema,
    toModelOutput: ({ output }) => ({ type: 'content', value: output.content }),
    execute: async (input, options) => {
      const profile = ctx.profiles.find((p) => p.name === input.agent_name && p.enabled)
      if (!profile) {
        const error = `No enabled agent profile found with name "${input.agent_name}".`
        return { content: [{ type: 'text', text: error }], error }
      }

      let effectiveCtx = ctx
      if (input.workspace) {
        const requested = resolve(input.workspace)
        const allowed = ctx.availableWorkspaces.map((p) => resolve(p))
        if (!allowed.includes(requested)) {
          const error = `Workspace "${input.workspace}" is not in the allowed workspace list. Available: ${ctx.availableWorkspaces.join(', ')}`
          return { content: [{ type: 'text', text: error }], error }
        }
        const exists = await fsAccess(requested)
          .then(() => true)
          .catch(() => false)
        if (!exists) {
          const error = `Workspace directory does not exist: "${requested}".`
          return { content: [{ type: 'text', text: error }], error }
        }
        const hasGit = await fsAccess(join(requested, '.git'))
          .then(() => true)
          .catch(() => false)
        if (!hasGit) {
          const error = `Workspace "${requested}" is not a Git repository. A Git repository is required for safe YOLO execution.`
          return { content: [{ type: 'text', text: error }], error }
        }
        effectiveCtx = { ...ctx, workspacePath: requested }
      }

      ctx.onSubagentStarted?.(input.agent_name)
      ctx.onProgress?.(`> ${input.prompt}\n${'─'.repeat(40)}\n`)
      try {
        const { lastMessage, ...result } = await runSubagent(
          profile,
          input.prompt,
          effectiveCtx,
          options.abortSignal,
          input.session_id || undefined
        )
        ctx.onSubagentFinished?.(
          input.agent_name,
          'success',
          lastMessage,
          result.sessionId,
          effectiveCtx.workspacePath
        )
        return result
      } catch (err) {
        ctx.onSubagentFinished?.(input.agent_name, 'cancelled')
        if (options.abortSignal?.aborted || isAbortError(err)) {
          const abortErr = err instanceof Error ? err : new Error('Subagent execution aborted.')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        const error = err instanceof Error ? err.message : 'Subagent execution failed.'
        return { content: [{ type: 'text', text: error }], error }
      }
    }
  })
}
