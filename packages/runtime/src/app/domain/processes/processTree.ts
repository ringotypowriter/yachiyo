import { spawnSync as nodeSpawnSync } from 'node:child_process'

import { signalProcessTree } from './killProcessTree.ts'

export interface ProcessTreeTerminationResult {
  alreadyExited: boolean
  delivered: boolean
  error: string | undefined
}

interface ProcessTreeDependencies {
  platform?: NodeJS.Platform
  isProcessRunning?: (pid: number) => boolean
  spawnSync?: (
    command: string,
    args: string[],
    options: { windowsHide?: boolean }
  ) => { status: number | null; stderr: string }
  signalPosixTree?: (pid: number, signal: NodeJS.Signals) => { delivered: boolean }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function spawnSync(
  command: string,
  args: string[],
  options: { windowsHide?: boolean }
): { status: number | null; stderr: string } {
  const result = nodeSpawnSync(command, args, { ...options, encoding: 'utf8' })
  return {
    status: result.status,
    stderr: typeof result.stderr === 'string' ? result.stderr : ''
  }
}

function terminateWindowsTree(
  pid: number,
  force: boolean,
  dependencies: ProcessTreeDependencies
): ProcessTreeTerminationResult {
  const running = dependencies.isProcessRunning ?? isProcessRunning
  if (!running(pid)) {
    return { alreadyExited: true, delivered: true, error: undefined }
  }

  const args = ['/PID', String(pid), '/T']
  if (force) args.push('/F')
  const run = dependencies.spawnSync ?? spawnSync
  const result = run('taskkill.exe', args, { windowsHide: true })
  if (result.status === 0) {
    return { alreadyExited: false, delivered: true, error: undefined }
  }

  if (!running(pid)) {
    return { alreadyExited: true, delivered: true, error: undefined }
  }

  const detail = result.stderr.trim()
  return {
    alreadyExited: false,
    delivered: false,
    error: `taskkill.exe exited with status ${String(result.status)}${detail ? `: ${detail}` : ''}`
  }
}

function terminatePosixTree(
  pid: number,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeDependencies
): ProcessTreeTerminationResult {
  const send = dependencies.signalPosixTree ?? signalProcessTree
  const result = send(pid, signal)
  return {
    alreadyExited: false,
    delivered: result.delivered,
    error: result.delivered ? undefined : `Unable to deliver ${signal} to process tree ${pid}.`
  }
}

export function gracefullyTerminateProcessTree(
  pid: number,
  dependencies: ProcessTreeDependencies = {}
): ProcessTreeTerminationResult {
  const platform = dependencies.platform ?? process.platform
  return platform === 'win32'
    ? terminateWindowsTree(pid, false, dependencies)
    : terminatePosixTree(pid, 'SIGTERM', dependencies)
}

export function forceTerminateProcessTree(
  pid: number,
  dependencies: ProcessTreeDependencies = {}
): ProcessTreeTerminationResult {
  const platform = dependencies.platform ?? process.platform
  return platform === 'win32'
    ? terminateWindowsTree(pid, true, dependencies)
    : terminatePosixTree(pid, 'SIGKILL', dependencies)
}

export interface ProcessTree {
  readonly platform?: NodeJS.Platform
  gracefullyTerminate(pid: number): ProcessTreeTerminationResult
  forceTerminate(pid: number): ProcessTreeTerminationResult
}

export function createProcessTree(dependencies: ProcessTreeDependencies = {}): ProcessTree {
  const platform = dependencies.platform ?? process.platform
  return {
    platform,
    gracefullyTerminate: (pid) =>
      gracefullyTerminateProcessTree(pid, { ...dependencies, platform }),
    forceTerminate: (pid) => forceTerminateProcessTree(pid, { ...dependencies, platform })
  }
}

export const processTree = createProcessTree()

interface ChildProcessHandle {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

function terminateChildWithoutPid(
  child: ChildProcessHandle,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
): ProcessTreeTerminationResult {
  try {
    const delivered = platform === 'win32' ? child.kill() : child.kill(signal)
    return {
      alreadyExited: !delivered,
      delivered,
      error: delivered ? undefined : `Unable to deliver ${signal} to child process.`
    }
  } catch (error) {
    return {
      alreadyExited: false,
      delivered: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function gracefullyTerminateChildProcess(
  child: ChildProcessHandle,
  strategy: ProcessTree = processTree
): ProcessTreeTerminationResult {
  return child.pid == null
    ? terminateChildWithoutPid(child, 'SIGTERM', strategy.platform ?? process.platform)
    : strategy.gracefullyTerminate(child.pid)
}

export function forceTerminateChildProcess(
  child: ChildProcessHandle,
  strategy: ProcessTree = processTree
): ProcessTreeTerminationResult {
  return child.pid == null
    ? terminateChildWithoutPid(child, 'SIGKILL', strategy.platform ?? process.platform)
    : strategy.forceTerminate(child.pid)
}
