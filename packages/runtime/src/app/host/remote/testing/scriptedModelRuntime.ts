import { randomUUID } from 'node:crypto'

import type { ModelRuntime, ModelStreamRequest } from '../../../../runtime/models/types.ts'

/**
 * Deterministic stand-in for a provider, used by remote tests and the fake-desktop harness.
 * It drives the real tool implementations so tool-call records, askUser waits, and plan
 * documents look exactly like a real run to the remote projections.
 *
 * Commands in the latest user message:
 * - `ask: <question>` — calls askUser with Yes/No choices and replies with the answer.
 * - `tool: <text>` — reports a completed bash-like tool call before replying.
 * - `slow: <text>` — streams 40 chunks 50 ms apart, so steer/cancel can land mid-run.
 * - In Plan Mode, writes the plan document and calls exitPlanMode.
 */
export interface ScriptedModelOptions {
  chunkDelayMs?: number
}

function latestUserText(request: ModelStreamRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

function allText(request: ModelStreamRequest): string {
  return request.messages
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )
    .join('\n')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      },
      { once: true }
    )
  })
}

async function runTool(
  request: ModelStreamRequest,
  toolName: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const toolCall = { toolCallId: `${toolName}-${randomUUID()}`, toolName, input }
  request.onToolCallStart?.({ toolCall })
  const definition = request.tools?.[toolName] as
    | { execute?: (input: unknown, options: unknown) => Promise<unknown> }
    | undefined
  if (!definition?.execute) {
    const output = { content: [{ type: 'text', text: 'ok' }], metadata: {} }
    request.onToolCallFinish?.({ toolCall, success: true, output })
    return output
  }
  const output = await definition.execute(input, {
    toolCallId: toolCall.toolCallId,
    messages: [],
    abortSignal: request.signal
  })
  request.onToolCallFinish?.({ toolCall, success: true, output })
  return output
}

function outputText(output: unknown): string {
  const content = (output as { content?: Array<{ type: string; text?: string }> })?.content
  return content?.find((part) => part.type === 'text')?.text ?? ''
}

export function createScriptedModelRuntime(options: ScriptedModelOptions = {}): ModelRuntime {
  const chunkDelayMs = options.chunkDelayMs ?? 15
  return {
    async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
      if (request.purpose && request.purpose !== 'chat') {
        yield 'Scripted title'
        return
      }
      // Per-turn reminders are appended to the last user message, so commands are read from
      // its first line only.
      const text = latestUserText(request).trimStart().split('\n')[0] ?? ''
      request.onReasoningDelta?.('Considering the request. ')

      // exitPlanMode is always registered (disabled outside Plan Mode); the plan path only
      // appears in the Plan Mode reminder, so it doubles as the mode signal.
      const planPath = allText(request).match(/\.yachiyo\/plan-[a-z0-9_-]+\.md/i)?.[0]
      if (planPath) {
        if (request.tools?.write) {
          await runTool(request, 'write', {
            path: planPath,
            content: `# Execution Plan\n\n## Goal\n${text.trim() || 'Do the thing.'}\n\n## Steps\n1. Implement it.\n\n## Validation\n- Run the tests.\n`
          })
        }
        await runTool(request, 'exitPlanMode', {})
        yield 'The plan is ready for review.'
        return
      }

      const ask = text.match(/^ask:\s*(.+)/i)
      if (ask) {
        yield 'Let me check with you. '
        const output = await runTool(request, 'askUser', {
          question: ask[1].trim().slice(0, 200),
          choices: ['Yes', 'No']
        })
        yield `You answered: ${outputText(output)}.`
        return
      }

      if (/^tool:/i.test(text)) {
        await runTool(request, 'bash', { command: 'echo scripted' })
      }

      const slow = /^slow:/i.test(text)
      const words = slow
        ? Array.from({ length: 40 }, (_, index) => `chunk${index} `)
        : `Scripted reply to: ${text.trim()}`.split(/(?<= )/)
      for (const word of words) {
        await sleep(slow ? 50 : chunkDelayMs, request.signal)
        yield word
      }
    }
  }
}
