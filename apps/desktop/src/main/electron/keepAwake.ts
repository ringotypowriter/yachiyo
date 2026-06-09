import { spawn as spawnChildProcess } from 'node:child_process'

const CAFFEINATE_PATH = '/usr/bin/caffeinate'
const CAFFEINATE_ARGS = ['-dims'] as const

interface KeepAwakeProcess {
  killed?: boolean
  kill(): boolean
  once(event: 'exit' | 'error', listener: () => void): unknown
  unref?(): void
}

interface KeepAwakeControllerOptions {
  platform?: NodeJS.Platform | string
  spawn?: (command: string, args: string[]) => KeepAwakeProcess
}

export interface KeepAwakeController {
  setEnabled(enabled: boolean): void
  stop(): void
}

export function createKeepAwakeController(
  options: KeepAwakeControllerOptions = {}
): KeepAwakeController {
  const platform = options.platform ?? process.platform
  const spawn =
    options.spawn ?? ((command, args) => spawnChildProcess(command, args, { stdio: 'ignore' }))
  let processRef: KeepAwakeProcess | null = null

  const stop = (): void => {
    const child = processRef
    processRef = null
    if (child && !child.killed) {
      child.kill()
    }
  }

  return {
    setEnabled(enabled: boolean): void {
      if (platform !== 'darwin') {
        return
      }
      if (!enabled) {
        stop()
        return
      }
      if (processRef) {
        return
      }

      const child = spawn(CAFFEINATE_PATH, [...CAFFEINATE_ARGS])
      processRef = child
      child.once('exit', () => {
        if (processRef === child) {
          processRef = null
        }
      })
      child.once('error', () => {
        if (processRef === child) {
          processRef = null
        }
      })
      child.unref?.()
    },
    stop
  }
}
