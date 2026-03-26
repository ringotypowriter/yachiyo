import { tool, type Tool } from 'ai'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { z } from 'zod'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'

import type { SubagentProfile } from '../../../../shared/yachiyo/protocol.ts'
import { readLoginShellEnvSync, mergeShellEnv } from '../../../userShellEnv.ts'
import { filterJsonLines } from './spawnUtils.ts'

const delegateCodingTaskInputSchema = z.object({
  agent_name: z.string().min(1),
  prompt: z.string().min(1),
  session_id: z
    .string()
    .optional()
    .describe(
      'Optional ACP session ID returned by a previous delegateCodingTask call. When provided, resumes that existing session instead of creating a new one.'
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
  profiles: SubagentProfile[]
  onProgress?: (chunk: string) => void
  onSubagentStarted?: (agentName: string) => void
  onSubagentFinished?: (
    agentName: string,
    status: 'success' | 'cancelled',
    lastMessage?: string
  ) => void
}

const SYSTEM_INSTRUCTION =
  "CRITICAL: The subagent has finished its execution. Before replying to the user, you MUST use your `read`, `bash` (e.g., git status, git diff), or `grep` tools to verify the actual file changes. Do not blindly trust the agent's summary. Once verified, report your findings to the user."

function autoApprovePermission(params: RequestPermissionRequest): RequestPermissionResponse {
  const allowOption = params.options.find(
    (o) => o.kind === 'allow_once' || o.kind === 'allow_always'
  )

  if (allowOption) {
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
  }

  // No allow option — pick the first option as a fallback
  return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } }
}

async function runSubagent(
  profile: SubagentProfile,
  prompt: string,
  ctx: DelegateCodingTaskContext,
  abortSignal?: AbortSignal,
  resumeSessionId?: string
): Promise<DelegateCodingTaskOutput & { lastMessage: string }> {
  let lastMessageText = ''
  let stopReason = 'end_turn'
  let wasStreamingText = false
  let hadAnyProgress = false

  const shellCommand = [profile.command, ...profile.args].join(' ')
  const shellEnv = readLoginShellEnvSync(process.env)
  const spawnEnv = mergeShellEnv(mergeShellEnv(process.env, shellEnv), profile.env)
  const shell = spawnEnv.SHELL || '/bin/zsh'
  const proc = spawn(shell, ['-lc', shellCommand], {
    cwd: ctx.workspacePath,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  })

  const procExited = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })

  const stdinStream = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>
  const stdoutStream = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(stdinStream, filterJsonLines(stdoutStream))

  // Forward stderr as progress lines
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    wasStreamingText = false
    hadAnyProgress = true
    ctx.onProgress?.(text)
  })

  const yoloClient = {
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve(autoApprovePermission(params))
    },
    sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        // Inject a newline when a new agent message starts after a non-text phase
        if (!wasStreamingText && hadAnyProgress) {
          ctx.onProgress?.('\n')
        }
        wasStreamingText = true
        hadAnyProgress = true
        lastMessageText += update.content.text
        ctx.onProgress?.(update.content.text)
      } else {
        wasStreamingText = false
      }
      return Promise.resolve()
    }
  }

  const connection = new ClientSideConnection(() => yoloClient, stream)
  let sessionId: string

  try {
    if (abortSignal?.aborted) {
      throw new Error('Aborted before start')
    }

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    })

    if (resumeSessionId !== undefined) {
      await connection.unstable_resumeSession({
        cwd: ctx.workspacePath,
        sessionId: resumeSessionId,
        mcpServers: []
      })
      sessionId = resumeSessionId
    } else {
      const sessionResult = await connection.newSession({
        cwd: ctx.workspacePath,
        mcpServers: []
      })
      sessionId = sessionResult.sessionId
    }

    // Wire abort: send cancel to agent then kill
    const killGroup = (): void => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        proc.kill('SIGKILL')
      }
    }

    const onAbort = (): void => {
      if (sessionId) {
        connection.cancel({ sessionId }).catch(() => {})
      }
      killGroup()
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    const promptResult = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: prompt }]
    })
    stopReason = promptResult.stopReason

    abortSignal?.removeEventListener('abort', onAbort)
  } finally {
    try {
      process.kill(-proc.pid!, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
    await procExited
  }

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
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input, options) => {
      const profile = ctx.profiles.find((p) => p.name === input.agent_name && p.enabled)
      if (!profile) {
        const error = `No enabled agent profile found with name "${input.agent_name}".`
        return { content: [{ type: 'text', text: error }], error }
      }

      ctx.onSubagentStarted?.(input.agent_name)
      ctx.onProgress?.(`> ${input.prompt}\n${'─'.repeat(40)}\n`)
      try {
        const { lastMessage, ...result } = await runSubagent(
          profile,
          input.prompt,
          ctx,
          options.abortSignal,
          input.session_id
        )
        ctx.onSubagentFinished?.(input.agent_name, 'success', lastMessage)
        return result
      } catch (err) {
        ctx.onSubagentFinished?.(input.agent_name, 'cancelled')
        const error = err instanceof Error ? err.message : 'Subagent execution failed.'
        return { content: [{ type: 'text', text: error }], error }
      }
    }
  })
}
