import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSocketTransportError } from './socket.ts'

test('Windows named-pipe connection errors become the app-not-running diagnostic', () => {
  for (const code of ['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ERROR_PIPE_BUSY']) {
    const source = Object.assign(new Error(`raw pipe failure ${code}`), { code })
    const normalized = normalizeSocketTransportError(source)

    assert.equal(normalized.message, 'Yachiyo app is not running. Start the app first.')
    assert.doesNotMatch(normalized.message, /pipe|ENOENT|ECONNREFUSED|EPIPE/u)
  }
})

test('unexpected transport failures remain observable', () => {
  const source = Object.assign(new Error('permission denied'), { code: 'EACCES' })

  assert.equal(normalizeSocketTransportError(source), source)
})
