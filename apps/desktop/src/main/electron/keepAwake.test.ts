import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createKeepAwakeController } from './keepAwake.ts'

class FakeChildProcess extends EventEmitter {
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

test('keep awake controller starts caffinate when enabled on macOS', () => {
  const spawned: Array<{ command: string; args: string[] }> = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    spawn: (command, args) => {
      spawned.push({ command, args })
      return new FakeChildProcess()
    }
  })

  controller.setEnabled(true)

  assert.deepEqual(spawned, [{ command: '/usr/bin/caffeinate', args: ['-dims'] }])
})

test('keep awake controller does not spawn duplicate caffinate processes', () => {
  const spawned: FakeChildProcess[] = []
  const controller = createKeepAwakeController({
    platform: 'darwin',
    spawn: () => {
      const child = new FakeChildProcess()
      spawned.push(child)
      return child
    }
  })

  controller.setEnabled(true)
  controller.setEnabled(true)

  assert.equal(spawned.length, 1)
})

test('keep awake controller stops caffinate when disabled', () => {
  const child = new FakeChildProcess()
  const controller = createKeepAwakeController({
    platform: 'darwin',
    spawn: () => child
  })

  controller.setEnabled(true)
  controller.setEnabled(false)

  assert.equal(child.killed, true)
})

test('keep awake controller ignores non-macOS platforms', () => {
  let spawnCount = 0
  const controller = createKeepAwakeController({
    platform: 'linux',
    spawn: () => {
      spawnCount += 1
      return new FakeChildProcess()
    }
  })

  controller.setEnabled(true)

  assert.equal(spawnCount, 0)
})
