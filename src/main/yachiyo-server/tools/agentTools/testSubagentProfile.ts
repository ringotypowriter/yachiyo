import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'

import type {
  SubagentProfile,
  TestSubagentProfileResult
} from '../../../../shared/yachiyo/protocol.ts'

const TEST_TIMEOUT_MS = 15_000

export async function testSubagentProfile(
  profile: SubagentProfile
): Promise<TestSubagentProfileResult> {
  const cwd = homedir()
  const shellCommand = [profile.command, ...profile.args].join(' ')

  const proc = spawn('/bin/zsh', ['-lc', shellCommand], {
    cwd,
    env: { ...process.env, ...profile.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const procExited = new Promise<void>((resolve) => {
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })

  const stdinStream = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>
  const stdoutStream = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(stdinStream, stdoutStream)

  const dummyClient = {
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve({
        outcome: { outcome: 'selected', optionId: params.options[0].optionId }
      })
    },
    sessionUpdate(): Promise<void> {
      return Promise.resolve()
    }
  }

  const connection = new ClientSideConnection(() => dummyClient, stream)

  const timeout = new Promise<TestSubagentProfileResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: 'Timed out after 15 seconds.' }), TEST_TIMEOUT_MS)
  )

  const handshake = (async (): Promise<TestSubagentProfileResult> => {
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await connection.newSession({ cwd, mcpServers: [] })
      connection.cancel({ sessionId }).catch(() => {})
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'ACP handshake failed.'
      }
    } finally {
      proc.kill('SIGKILL')
      await procExited
    }
  })()

  return Promise.race([handshake, timeout])
}
