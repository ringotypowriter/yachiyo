import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { installRuntimeHostInterruptGuard } from './runtimeHostInterruptGuard.ts'

test('runtime host consumes SIGINT until main completes shutdown', () => {
  const target = new EventEmitter()
  const removeGuard = installRuntimeHostInterruptGuard(target)

  assert.equal(target.emit('SIGINT'), true)

  removeGuard()
  assert.equal(target.emit('SIGINT'), false)
})
