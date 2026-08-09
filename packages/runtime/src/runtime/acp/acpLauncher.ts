import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import { ndJsonStream } from '@agentclientprotocol/sdk'

import type { SubagentProfile } from '@yachiyo/shared/protocol'
import { registerActiveChildProcess } from '../../app/domain/processes/activeProcessRegistry.ts'
import { mergeShellEnv } from '../shell/loginShellEnv.ts'
import {
  buildBashCommand,
  resolveHostShellRuntime,
  type ShellRuntime
} from '../shell/shellRuntime.ts'
import { filterJsonLines } from '../../tools/agentTools/spawnUtils.ts'

export interface AcpLaunchResult {
  proc: ChildProcess
  stream: ReturnType<typeof ndJsonStream>
  procExited: Promise<void>
}

export function launchAcpProcess(
  profile: SubagentProfile,
  cwd: string,
  shellRuntime?: ShellRuntime
): AcpLaunchResult {
  const runtime =
    shellRuntime ?? resolveHostShellRuntime({ env: mergeShellEnv(process.env, profile.env) })
  const command = runtime.command(buildBashCommand(profile.command, profile.args), { cwd })
  const proc = spawn(command.executable, command.args, {
    ...command.options,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  registerActiveChildProcess(proc)

  const procExited = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })

  const stdinStream = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>
  const stdoutStream = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(stdinStream, filterJsonLines(stdoutStream))

  return { proc, stream, procExited }
}
