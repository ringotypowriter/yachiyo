import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldEnableCommandSocket } from './commandSocketMode.ts'

test('development disables the command socket by default', () => {
  assert.equal(shouldEnableCommandSocket(true, {}), false)
})

test('development enables the command socket with YACHIYO_DEV_CLI', () => {
  assert.equal(shouldEnableCommandSocket(true, { YACHIYO_DEV_CLI: '1' }), true)
})

test('production always enables the command socket', () => {
  assert.equal(shouldEnableCommandSocket(false, {}), true)
})
