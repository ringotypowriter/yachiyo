import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunYachiyoCliOptions } from './core/types.ts'
import { runYachiyoCli } from './yachiyoCli.ts'

function captureOutput(): {
  options: Pick<RunYachiyoCliOptions, 'stdout'>
  read(): string
} {
  let output = ''
  return {
    options: {
      stdout: {
        write(chunk) {
          output += String(chunk)
          return true
        }
      }
    },
    read: () => output
  }
}

test('update status --json reports the running process and an available target distinctly', async () => {
  const output = captureOutput()
  const options: RunYachiyoCliOptions = {
    ...output.options,
    getAppUpdateStatus: async () => ({
      state: 'available',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1'
    })
  }

  await runYachiyoCli(['update', 'status', '--json'], options)

  assert.deepEqual(JSON.parse(output.read()), {
    state: 'available',
    runningVersion: '1.5.1',
    targetVersion: '1.6.0-beta.1'
  })
})

test('update status distinguishes a downloaded update from an up-to-date process', async () => {
  const readyOutput = captureOutput()
  await runYachiyoCli(['update', 'status'], {
    ...readyOutput.options,
    getAppUpdateStatus: async () => ({
      state: 'ready',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1'
    })
  })

  assert.match(readyOutput.read(), /downloaded and ready to restart/i)
  assert.match(readyOutput.read(), /running version: 1\.5\.1/i)

  const currentOutput = captureOutput()
  await runYachiyoCli(['update', 'status'], {
    ...currentOutput.options,
    getAppUpdateStatus: async () => ({ state: 'up-to-date', runningVersion: '1.5.1' })
  })

  assert.match(currentOutput.read(), /Yachiyo 1\.5\.1 is up to date/i)
})

test('update apply warns before restart and succeeds only with the relaunched process version', async () => {
  const output = captureOutput()
  const options: RunYachiyoCliOptions = {
    ...output.options,
    applyAppUpdate: async () => {
      assert.match(output.read(), /restart.*interrupt/i)
      return {
        state: 'updated',
        previousVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        runningVersion: '1.6.0-beta.1',
        interruptedRunCount: 1
      }
    }
  }

  await runYachiyoCli(['update', 'apply'], options)

  assert.match(output.read(), /Updated Yachiyo from 1\.5\.1 to 1\.6\.0-beta\.1/i)
  assert.match(output.read(), /running process: 1\.6\.0-beta\.1/i)
})

test('update apply --json returns a single machine-readable final result', async () => {
  const output = captureOutput()
  const result = {
    state: 'updated' as const,
    previousVersion: '1.5.1',
    targetVersion: '1.6.0-beta.1',
    runningVersion: '1.6.0-beta.1',
    interruptedRunCount: 0
  }

  await runYachiyoCli(['update', 'apply', '--json'], {
    ...output.options,
    applyAppUpdate: async () => result
  })

  assert.deepEqual(JSON.parse(output.read()), result)
})
