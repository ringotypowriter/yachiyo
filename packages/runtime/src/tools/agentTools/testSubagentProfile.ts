import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'

import type { SubagentProfile, TestSubagentProfileResult } from '@yachiyo/shared/protocol'
import { registerActiveChildProcess } from '../../app/domain/processes/activeProcessRegistry.ts'
import {
  forceTerminateChildProcess,
  processTree as defaultProcessTree,
  type ProcessTree
} from '../../app/domain/processes/processTree.ts'
import { mergeShellEnv } from '../../runtime/shell/loginShellEnv.ts'
import {
  buildBashCommand,
  resolveHostShellRuntime,
  type ShellRuntime
} from '../../runtime/shell/shellRuntime.ts'
import { filterJsonLines } from './spawnUtils.ts'

const TEST_TIMEOUT_MS = 60_000

interface TestSubagentProfileDependencies {
  processTree?: ProcessTree
  shellRuntime?: ShellRuntime
  timeoutMs?: number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export async function testSubagentProfile(
  profile: SubagentProfile,
  dependencies: TestSubagentProfileDependencies = {}
): Promise<TestSubagentProfileResult> {
  const cwd = homedir()
  const runtime =
    dependencies.shellRuntime ??
    resolveHostShellRuntime({ env: mergeShellEnv(process.env, profile.env) })
  const command = runtime.command(buildBashCommand(profile.command, profile.args), { cwd })
  const proc = spawn(command.executable, command.args, {
    ...command.options,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  registerActiveChildProcess(proc)

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

  const scheduleTimeout = dependencies.setTimeout ?? setTimeout
  const cancelTimeout = dependencies.clearTimeout ?? clearTimeout
  const timeoutMs = dependencies.timeoutMs ?? TEST_TIMEOUT_MS
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TestSubagentProfileResult>((resolve) => {
    timeoutTimer = scheduleTimeout(
      () => resolve({ ok: false, error: 'Timed out after 60 seconds.' }),
      timeoutMs
    )
  })

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
    }
  })()

  try {
    return await Promise.race([handshake, timeout])
  } finally {
    if (timeoutTimer !== undefined) cancelTimeout(timeoutTimer)
    const result = forceTerminateChildProcess(proc, dependencies.processTree ?? defaultProcessTree)
    if (!result.delivered) {
      console.warn('[yachiyo][subagent-profile-test] process-tree termination failed', {
        pid: proc.pid,
        error: result.error
      })
    }
    await procExited
  }
}
