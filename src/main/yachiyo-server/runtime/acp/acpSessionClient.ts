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

  try {
    if (abortSignal?.aborted) {
      throw new Error('Aborted before start')
    }

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    })

    if (resumeSessionId !== undefined) {
      try {
        await connection.unstable_resumeSession({
          cwd,
          sessionId: resumeSessionId,
          mcpServers: []
        })
      } catch (resumeErr) {
        const detail = resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
        throw new Error(
          `Session resume failed for session_id "${resumeSessionId}": ${detail}. ` +
            `Call delegateCodingTask again without session_id to start a new session.`
        )
      }
      sessionId = resumeSessionId
    } else {
      const sessionResult = await connection.newSession({
        cwd,
        mcpServers: []
      })
      sessionId = sessionResult.sessionId
    }

    const onAbort = (): void => {
      connection.cancel({ sessionId }).catch(() => {})
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
    killGroup()
    await procExited
  }

  return {
    sessionId,
    lastMessageText: adapter.getLastMessageText(),
    stopReason
  }
}
