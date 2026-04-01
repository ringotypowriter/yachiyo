import type { ChildProcess } from 'node:child_process'

import { ClientSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ndJsonStream } from '@agentclientprotocol/sdk'

import type { AcpStreamAdapter } from './acpStreamAdapter.ts'

export interface AcpSessionOptions {
  abortSignal?: AbortSignal
  resumeSessionId?: string
}

export interface AcpSessionResult {
  sessionId: string
  lastMessageText: string
  stopReason: string
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  }
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted', 'AbortError')),
        { once: true }
      )
    })
  ])
}

export async function runAcpSession(
  stream: ReturnType<typeof ndJsonStream>,
  proc: ChildProcess,
  procExited: Promise<void>,
  cwd: string,
  prompt: string,
  adapter: AcpStreamAdapter,
  options: AcpSessionOptions = {}
): Promise<AcpSessionResult> {
  const { abortSignal, resumeSessionId } = options
  const connection = new ClientSideConnection(() => adapter.yoloClient, stream)
  let sessionId!: string
  let stopReason = 'end_turn'

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

  try {
    await raceAbort(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      }),
      abortSignal
    )

    if (resumeSessionId !== undefined) {
      try {
        await raceAbort(
          connection.unstable_resumeSession({
            cwd,
            sessionId: resumeSessionId,
            mcpServers: []
          }),
          abortSignal
        )
      } catch (resumeErr) {
        if (resumeErr instanceof DOMException && resumeErr.name === 'AbortError') {
          throw resumeErr
        }
        const detail = resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
        throw new Error(
          `Session resume failed for session_id "${resumeSessionId}": ${detail}. ` +
            `Call delegateCodingTask again without session_id to start a new session.`
        )
      }
      sessionId = resumeSessionId
    } else {
      const sessionResult = await raceAbort(
        connection.newSession({
          cwd,
          mcpServers: []
        }),
        abortSignal
      )
      sessionId = sessionResult.sessionId
    }

    const promptResult = await raceAbort(
      connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: prompt }]
      }),
      abortSignal
    )
    stopReason = promptResult.stopReason
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    killGroup()
    await procExited
  }

  return {
    sessionId,
    lastMessageText: adapter.getLastMessageText(),
    stopReason
  }
}
