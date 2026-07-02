import { spawn } from 'node:child_process'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelMessage } from '../../runtime/models/types.ts'

export type ClaudeCodeProbeDecision = { action: 'silent' } | { action: 'send'; message: string }

export interface ClaudeCodeProbeCommand {
  command: 'claude'
  args: string[]
}

export interface ClaudeCodeProbeRunCommandInput extends ClaudeCodeProbeCommand {
  cwd: string
  stdin: string
  signal?: AbortSignal
}

export interface RunClaudeCodeGroupProbeInput {
  messages: ModelMessage[]
  workspacePath: string
  providerName?: string
  model?: string
  signal?: AbortSignal
  runCommand?: (input: ClaudeCodeProbeRunCommandInput) => Promise<string>
}

export type RunClaudeCodeGroupProbeResult =
  | {
      status: 'success'
      decision: ClaudeCodeProbeDecision
      auxiliaryResult: Extract<AuxiliaryTextGenerationResult, { status: 'success' }>
    }
  | {
      status: 'failed'
      error: string
      auxiliaryResult: Extract<AuxiliaryTextGenerationResult, { status: 'failed' }>
    }

const CLAUDE_CODE_PROVIDER_SETTINGS: ProviderSettings = {
  providerName: 'claude-code-cli',
  provider: 'anthropic',
  model: 'claude-code-default',
  apiKey: '',
  baseUrl: ''
}
export const CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID = 'claude-code-send-group-message'

function formatMessageContent(content: ModelMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

export function buildClaudeCodeProbeCommand(input: { model?: string }): ClaudeCodeProbeCommand {
  const args = [
    '-p',
    '--no-session-persistence',
    '--safe-mode',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--output-format',
    'text'
  ]
  if (input.model?.trim()) {
    args.push('--model', input.model.trim())
  }
  return { command: 'claude', args }
}

export function buildClaudeCodeProbePrompt(messages: ModelMessage[]): string {
  const transcript = messages
    .map(
      (message) => `<${message.role}>\n${formatMessageContent(message.content)}\n</${message.role}>`
    )
    .join('\n\n')

  return `\
You are a claude -p headless adapter for Yachiyo's group probe.

The original group-probe instructions may say to call \`send_group_message\`.
In this headless mode, you cannot call tools. Instead, decide whether that tool
should be called and return ONLY one JSON object:

{"action": "send", "message": "the exact short group message"}
{"action": "silent"}

No markdown, no explanation, no extra keys.

<probe_messages>
${transcript}
</probe_messages>`
}

function stripJsonFence(output: string): string {
  const trimmed = output.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fence ? fence[1]!.trim() : trimmed
}

export function parseClaudeCodeProbeDecision(output: string): ClaudeCodeProbeDecision {
  const parsed = JSON.parse(stripJsonFence(output)) as {
    action?: unknown
    message?: unknown
  }

  if (parsed.action === 'silent') {
    return { action: 'silent' }
  }

  if (parsed.action === 'send' && typeof parsed.message === 'string') {
    const message = parsed.message.trim()
    if (message.length === 0) {
      throw new Error('Claude Code probe returned an empty send message')
    }
    return { action: 'send', message }
  }

  throw new Error('Claude Code probe returned invalid JSON decision')
}

function buildSentResponseMessages(message: string): unknown[] {
  const toolCallId = CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId,
          toolName: 'send_group_message',
          input: { message }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'send_group_message',
          output: { type: 'text', value: 'Message sent.' }
        }
      ]
    }
  ]
}

function createAuxiliarySuccessResult(
  output: string,
  providerName: string | undefined,
  model: string | undefined,
  decision: ClaudeCodeProbeDecision
): Extract<AuxiliaryTextGenerationResult, { status: 'success' }> {
  const settings = {
    ...CLAUDE_CODE_PROVIDER_SETTINGS,
    providerName: providerName?.trim() || CLAUDE_CODE_PROVIDER_SETTINGS.providerName,
    model: model?.trim() || CLAUDE_CODE_PROVIDER_SETTINGS.model
  }

  return {
    status: 'success',
    settings,
    text: output,
    ...(decision.action === 'send'
      ? {
          responseMessages: buildSentResponseMessages(decision.message)
        }
      : {})
  }
}

function createAuxiliaryFailedResult(
  error: string,
  providerName: string | undefined,
  model: string | undefined
): Extract<AuxiliaryTextGenerationResult, { status: 'failed' }> {
  return {
    status: 'failed',
    error,
    settings: {
      ...CLAUDE_CODE_PROVIDER_SETTINGS,
      providerName: providerName?.trim() || CLAUDE_CODE_PROVIDER_SETTINGS.providerName,
      model: model?.trim() || CLAUDE_CODE_PROVIDER_SETTINGS.model
    }
  }
}

export async function runClaudeCodeGroupProbe(
  input: RunClaudeCodeGroupProbeInput
): Promise<RunClaudeCodeGroupProbeResult> {
  const command = buildClaudeCodeProbeCommand({ model: input.model })
  const stdin = buildClaudeCodeProbePrompt(input.messages)

  try {
    const output = await (input.runCommand ?? runProcess)({
      ...command,
      cwd: input.workspacePath,
      stdin,
      signal: input.signal
    })
    const decision = parseClaudeCodeProbeDecision(output)
    return {
      status: 'success',
      decision,
      auxiliaryResult: createAuxiliarySuccessResult(
        output,
        input.providerName,
        input.model,
        decision
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      error: message,
      auxiliaryResult: createAuxiliaryFailedResult(message, input.providerName, input.model)
    }
  }
}

async function runProcess(input: ClaudeCodeProbeRunCommandInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let stdinError: Error | undefined
    const onAbort = (): void => {
      child.kill('SIGTERM')
      reject(new Error('Claude Code probe aborted'))
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdin.on('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        stdinError = error
        return
      }
      reject(error)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() || stdinError?.message || `claude exited with code ${code}`))
    })
    child.stdin.end(input.stdin)
  })
}
