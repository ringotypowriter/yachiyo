import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import { ndJsonStream } from '@agentclientprotocol/sdk'

import type { SubagentProfile } from '../../../../shared/yachiyo/protocol.ts'
import { mergeShellEnv, readLoginShellEnvSync } from '../../../userShellEnv.ts'
import { filterJsonLines } from '../../tools/agentTools/spawnUtils.ts'

export interface AcpLaunchResult {
  proc: ChildProcess
  stream: ReturnType<typeof ndJsonStream>
  procExited: Promise<void>
}

export function launchAcpProcess(profile: SubagentProfile, cwd: string): AcpLaunchResult {
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

  const procExited = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    proc.on('error', () => resolve())
  })

  const stdinStream = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>
  const stdoutStream = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(stdinStream, filterJsonLines(stdoutStream))

  return { proc, stream, procExited }
}
