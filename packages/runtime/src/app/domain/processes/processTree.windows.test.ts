import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createProcessTree,
  forceTerminateChildProcess,
  forceTerminateProcessTree,
  gracefullyTerminateProcessTree
} from './processTree.ts'

interface SpawnCall {
  command: string
  args: string[]
  options: { windowsHide?: boolean }
}

function createWindowsDeps(input?: { running?: boolean; status?: number; stderr?: string }): {
  calls: SpawnCall[]
  deps: {
    platform: NodeJS.Platform
    isProcessRunning: () => boolean
    spawnSync: (
      command: string,
      args: string[],
      options: { windowsHide?: boolean }
    ) => {
      status: number | null
      stderr: string
    }
  }
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    deps: {
      platform: 'win32',
      isProcessRunning: () => input?.running ?? true,
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: input?.status ?? 0, stderr: input?.stderr ?? '' }
      }
    }
  }
}

test('Windows graceful termination uses taskkill for the complete process tree', () => {
  const { calls, deps } = createWindowsDeps()

  assert.deepEqual(gracefullyTerminateProcessTree(4120, deps), {
    alreadyExited: false,
    delivered: true,
    error: undefined
  })
  assert.deepEqual(calls, [
    {
      command: 'taskkill.exe',
      args: ['/PID', '4120', '/T'],
      options: { windowsHide: true }
    }
  ])
})

test('Windows force termination adds /F without sending a Unix signal', () => {
  const { calls, deps } = createWindowsDeps()

  assert.equal(forceTerminateProcessTree(4120, deps).delivered, true)
  assert.deepEqual(calls[0], {
    command: 'taskkill.exe',
    args: ['/PID', '4120', '/T', '/F'],
    options: { windowsHide: true }
  })
})

test('Windows termination is idempotent when the root already exited', () => {
  const { calls, deps } = createWindowsDeps({ running: false })

  assert.deepEqual(gracefullyTerminateProcessTree(4120, deps), {
    alreadyExited: true,
    delivered: true,
    error: undefined
  })
  assert.deepEqual(calls, [])
})

test('taskkill failure stays observable to task and session state owners', () => {
  const { deps } = createWindowsDeps({ status: 5, stderr: 'Access is denied.' })

  assert.deepEqual(forceTerminateProcessTree(4120, deps), {
    alreadyExited: false,
    delivered: false,
    error: 'taskkill.exe exited with status 5: Access is denied.'
  })
})

test('taskkill failure is idempotent when the process exits during termination', () => {
  let runningChecks = 0
  const { calls, deps } = createWindowsDeps({ status: 128, stderr: 'Process not found.' })
  deps.isProcessRunning = () => {
    runningChecks += 1
    return runningChecks === 1
  }

  assert.deepEqual(forceTerminateProcessTree(4120, deps), {
    alreadyExited: true,
    delivered: true,
    error: undefined
  })
  assert.equal(runningChecks, 2)
  assert.equal(calls.length, 1)
})

test('Windows pid-less child fallback does not pass a Unix signal', () => {
  const signals: Array<NodeJS.Signals | number | undefined> = []
  const child = {
    pid: undefined,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal)
      return true
    }
  }
  const strategy = createProcessTree({ platform: 'win32' })

  assert.deepEqual(forceTerminateChildProcess(child, strategy), {
    alreadyExited: false,
    delivered: true,
    error: undefined
  })
  assert.deepEqual(signals, [undefined])
})
