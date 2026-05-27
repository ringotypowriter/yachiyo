import type { ChildProcess } from 'node:child_process'

import { ClientSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ContentBlock, ndJsonStream } from '@agentclientprotocol/sdk'

import type { AcpStreamAdapter, AcpYoloClient } from './acpStreamAdapter.ts'

export interface AcpSessionOptions {
  abortSignal?: AbortSignal
  resumeSessionId?: string
  /**
   * When true, the agent process is NOT killed after a successful prompt
   * completion. The caller is responsible for returning it to a process pool
   * or killing it manually. On abort or error the process is always killed
   * regardless of this flag.
   */
  keepAlive?: boolean
}

export interface AcpSessionResult {
  sessionId: string
  lastMessageText: string
  stopReason: string
}

export interface AcpWarmSession {
  proc: ChildProcess
  connection: ClientSideConnection
  sessionId: string
  procExited: Promise<void>
  adapterRef: { current: AcpStreamAdapter }
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

function raceProcExit<T>(
  promise: Promise<T>,
  proc: ChildProcess,
  procExited: Promise<void>
): Promise<T> {
  return Promise.race([
    promise,
    procExited.then(() => {
      throw new Error(
        `ACP agent process exited unexpectedly (code=${proc.exitCode} signal=${proc.signalCode}) before the request completed.`
      )
    })
  ])
}

function killGroup(proc: ChildProcess): void {
  try {
    process.kill(-proc.pid!, 'SIGKILL')
  } catch {
    proc.kill('SIGKILL')
  }
}

export async function runAcpSession(
  stream: ReturnType<typeof ndJsonStream>,
  proc: ChildProcess,
  procExited: Promise<void>,
  cwd: string,
  prompt: ContentBlock[],
  adapter: AcpStreamAdapter,
  adapterRef: { current: AcpStreamAdapter },
  options: AcpSessionOptions = {}
): Promise<AcpSessionResult & { warmSession?: AcpWarmSession }> {
  const { abortSignal, resumeSessionId, keepAlive } = options
  // Stable proxy so the SDK always calls the same object regardless of caching behaviour.
  // Swapping adapterRef.current before each warm prompt routes updates to the new adapter.
  const proxyYoloClient: AcpYoloClient = {
    requestPermission: (params) => adapterRef.current.yoloClient.requestPermission(params),
    sessionUpdate: (params) => adapterRef.current.yoloClient.sessionUpdate(params)
  }
  const connection = new ClientSideConnection(() => proxyYoloClient, stream)
  let sessionId!: string
  let stopReason = 'end_turn'
  let sessionCompleted = false

  const onAbort = (): void => {
    if (sessionId) {
      connection.cancel({ sessionId }).catch(() => {})
    }
    killGroup(proc)
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    await raceProcExit(
      raceAbort(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        }),
        abortSignal
      ),
      proc,
      procExited
    )

    if (resumeSessionId !== undefined) {
      try {
        await raceProcExit(
          raceAbort(
            connection.unstable_resumeSession({
              cwd,
              sessionId: resumeSessionId,
              mcpServers: []
            }),
            abortSignal
          ),
          proc,
          procExited
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
      const sessionResult = await raceProcExit(
        raceAbort(
          connection.newSession({
            cwd,
            mcpServers: []
          }),
          abortSignal
        ),
        proc,
        procExited
      )
      sessionId = sessionResult.sessionId
    }

    const promptResult = await raceProcExit(
      raceAbort(
        connection.prompt({
          sessionId,
          prompt
        }),
        abortSignal
      ),
      proc,
      procExited
    )
    stopReason = promptResult.stopReason
    sessionCompleted = true
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    const preserve = keepAlive === true && sessionCompleted && !abortSignal?.aborted
    if (!preserve) {
      killGroup(proc)
      await procExited
    }
  }

  const warmSession =
    keepAlive === true && sessionCompleted && !abortSignal?.aborted
      ? {
          proc,
          connection,
          sessionId,
          procExited,
          adapterRef
        }
      : undefined

  return {
    sessionId,
    lastMessageText: adapter.getLastMessageText(),
    stopReason,
    ...(warmSession ? { warmSession } : {})
  }
}

export async function continueAcpSession(
  session: AcpWarmSession,
  prompt: ContentBlock[],
  adapter: AcpStreamAdapter,
  options: Pick<AcpSessionOptions, 'abortSignal' | 'keepAlive'> = {}
): Promise<AcpSessionResult> {
  const { abortSignal, keepAlive } = options
  let stopReason = 'end_turn'
  let sessionCompleted = false

  session.adapterRef.current = adapter

  const onAbort = (): void => {
    session.connection.cancel({ sessionId: session.sessionId }).catch(() => {})
    killGroup(session.proc)
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    const promptResult = await raceAbort(
      session.connection.prompt({
        sessionId: session.sessionId,
        prompt
      }),
      abortSignal
    )
    stopReason = promptResult.stopReason
    sessionCompleted = true
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    const preserve = keepAlive === true && sessionCompleted && !abortSignal?.aborted
    if (!preserve) {
      killGroup(session.proc)
      await session.procExited
    }
  }

  return {
    sessionId: session.sessionId,
    lastMessageText: adapter.getLastMessageText(),
    stopReason
  }
}
