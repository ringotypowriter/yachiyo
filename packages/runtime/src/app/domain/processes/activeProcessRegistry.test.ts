import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { ProcessTree } from './processTree.ts'
import { ActiveProcessRegistry } from './activeProcessRegistry.ts'

class FakeChild extends EventEmitter {
  readonly pid: number

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(): boolean {
    return true
  }
}

test('active registry synchronously force-terminates only live registered children', () => {
  const terminatedPids: number[] = []
  const processTree: ProcessTree = {
    forceTerminate(pid) {
      terminatedPids.push(pid)
      return { alreadyExited: false, delivered: true, error: undefined }
    },
    gracefullyTerminate: () => ({ alreadyExited: false, delivered: true, error: undefined })
  }
  const registry = new ActiveProcessRegistry(processTree)
  const exited = new FakeChild(4100)
  const active = new FakeChild(4200)

  registry.register(exited as never)
  registry.register(active as never)
  exited.emit('exit', 0, null)

  registry.syncTerminateAll()
  registry.syncTerminateAll()

  assert.deepEqual(terminatedPids, [4200])
  assert.equal(active.listenerCount('exit'), 0)
  assert.equal(active.listenerCount('error'), 0)
  assert.equal(active.listenerCount('close'), 0)
})

test('registering the same child twice keeps one cleanup owner', () => {
  let terminateCalls = 0
  const processTree: ProcessTree = {
    forceTerminate: () => {
      terminateCalls += 1
      return { alreadyExited: false, delivered: true, error: undefined }
    },
    gracefullyTerminate: () => ({ alreadyExited: false, delivered: true, error: undefined })
  }
  const registry = new ActiveProcessRegistry(processTree)
  const child = new FakeChild(4300)

  const firstUnregister = registry.register(child as never)
  const secondUnregister = registry.register(child as never)
  assert.equal(firstUnregister, secondUnregister)

  registry.syncTerminateAll()

  assert.equal(terminateCalls, 1)
})
