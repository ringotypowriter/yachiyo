import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import { connectHeadless } from '../services/headless.ts'
import { runChatTurn } from '../services/chat.ts'
import type { RunYachiyoCliOptions } from '../core/types.ts'

export async function handleChatCommand(
  positionals: string[],
  flags: Map<string, string>,
  options: RunYachiyoCliOptions
): Promise<void> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const input = options.stdin ?? process.stdin
  if (flags.has('--thread') && flags.has('--workspace')) {
    throw new Error('--workspace only applies when creating a new thread')
  }
  let prompt = positionals.join(' ').trim()
  if (!prompt && !input.isTTY) {
    if (options.readStdin) prompt = (await options.readStdin()).trim()
    else {
      for await (const chunk of input) prompt += chunk.toString()
      prompt = prompt.trim()
    }
  }
  if (!input.isTTY && !prompt) throw new Error('Pass a prompt or pipe text into yachiyo chat')
  const connection = await (options.connectHeadless ?? connectHeadless)()
  const terminal = input.isTTY ? createInterface({ input, output: process.stderr }) : null
  let threadId = flags.get('--thread')
  let active: AbortController | null = null
  let exiting = false
  let disconnected = false
  const session = new AbortController()
  const stopReading = (): void => {
    exiting = true
    session.abort()
    active?.abort()
  }
  const interrupt = (): void => {
    if (active) active.abort()
    else {
      stopReading()
      terminal?.close()
    }
  }
  const onDisconnect = (): void => {
    disconnected = true
    stopReading()
    terminal?.close()
  }
  void connection.closed.then(onDisconnect)
  terminal?.on('close', stopReading)
  terminal?.on('SIGINT', interrupt)
  process.on('SIGINT', interrupt)
  const onEvent = (event: YachiyoServerEvent): void => {
    if (flags.has('--json')) stdout.write(JSON.stringify(event) + '\n')
    else if (event.type === 'message.delta') stdout.write(event.delta)
  }
  try {
    do {
      let content = prompt
      if (!content) {
        try {
          content = (await terminal!.question('You> ', { signal: session.signal })).trim()
        } catch (error) {
          if (exiting) break
          throw error
        }
      }
      if (exiting || content === '/exit' || content === '/quit') break
      if (!content) continue
      active = new AbortController()
      threadId = await runChatTurn(connection, {
        content,
        threadId,
        workspacePath: flags.has('--workspace') ? resolve(flags.get('--workspace')!) : undefined,
        signal: active.signal,
        onEvent,
        onAccepted(accepted) {
          if (flags.has('--json'))
            stdout.write(
              JSON.stringify({
                type: 'chat.accepted',
                threadId: accepted.thread.id,
                runId: accepted.runId
              }) + '\n'
            )
          else if (!threadId) stderr.write(`Thread: ${accepted.thread.id}\n`)
        },
        ...(terminal
          ? {
              answerQuestion: (question) =>
                terminal.question(
                  `\n${question.question}\n${question.choices?.join(' / ') ?? ''}\nAnswer> `,
                  { signal: active!.signal }
                )
            }
          : {})
      })
      active = null
      if (!flags.has('--json')) stdout.write('\n')
    } while (!prompt && !exiting)
    if (disconnected) throw new Error('Yachiyo headless disconnected')
  } finally {
    process.off('SIGINT', interrupt)
    active?.abort()
    terminal?.close()
    connection.client.close()
  }
}
