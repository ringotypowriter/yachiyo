import assert from 'node:assert/strict'
import test from 'node:test'

import type { SubagentProfile } from '@yachiyo/shared/protocol'
import type { ProcessTree } from '../../app/domain/processes/processTree.ts'
import type { ShellRuntime } from '../../runtime/shell/shellRuntime.ts'
import { testSubagentProfile } from './testSubagentProfile.ts'

const profile: SubagentProfile = {
  id: 'timeout-profile',
  name: 'Timeout profile',
  enabled: true,
  description: '',
  command: 'ignored',
  args: [],
  env: {}
}

test('profile timeout terminates through ProcessTree, clears its timer, and awaits exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const terminatedPids: number[] = []
  const processTree: ProcessTree = {
    gracefullyTerminate: () => ({ alreadyExited: false, delivered: true, error: undefined }),
    forceTerminate(pid) {
      terminatedPids.push(pid)
      process.kill(pid, 'SIGKILL')
      return { alreadyExited: false, delivered: true, error: undefined }
    }
  }
  const shellRuntime: ShellRuntime = {
    kind: 'login-shell',
    executable: process.execPath,
    environment: process.env,
    spawnOptions: { detached: false, windowsHide: true },
    args: () => [],
    command: (_command, { cwd }) => ({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 100)'],
      options: {
        cwd,
        detached: false,
        env: process.env,
        windowsHide: true
      }
    })
  }
  let clearedTimers = 0

  const pending = testSubagentProfile(profile, {
    processTree,
    shellRuntime,
    timeoutMs: 10,
    clearTimeout(timer) {
      clearedTimers += 1
      clearTimeout(timer as NodeJS.Timeout)
    }
  })
  t.mock.timers.tick(60_000)
  const result = await pending

  assert.deepEqual(result, { ok: false, error: 'Timed out after 60 seconds.' })
  assert.equal(terminatedPids.length, 1)
  assert.equal(clearedTimers, 1)
})
