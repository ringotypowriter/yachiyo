import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'

import type {
  SubagentProfile,
  TestSubagentProfileResult
} from '../../../../shared/yachiyo/protocol.ts'
import { readLoginShellEnvSync, mergeShellEnv } from '../../../userShellEnv.ts'
import { filterJsonLines } from './spawnUtils.ts'

const TEST_TIMEOUT_MS = 60_000

export async function testSubagentProfile(
  profile: SubagentProfile
): Promise<TestSubagentProfileResult> {
  const cwd = homedir()
  const shellCommand = [profile.command, ...profile.args].join(' ')

  const shellEnv = readLoginShellEnvSync(process.env)
  const spawnEnv = mergeShellEnv(mergeShellEnv(process.env, shellEnv), profile.env)
  const shell = spawnEnv.SHELL || '/bin/zsh'

  const proc = spawn(shell, ['-lc', shellCommand], {
    cwd,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  })

  proc.stderr.resume()

  const procExited = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })

  const stdinStream = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>
  const stdoutStream = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(stdinStream, filterJsonLines(stdoutStream))

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
    setTimeout(() => resolve({ ok: false, error: 'Timed out after 60 seconds.' }), TEST_TIMEOUT_MS)
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
      try {
        process.kill(-proc.pid!, 'SIGKILL') // kill entire process group
      } catch {
        proc.kill('SIGKILL')
      }
      await procExited
    }
  })()

  return Promise.race([handshake, timeout])
}
