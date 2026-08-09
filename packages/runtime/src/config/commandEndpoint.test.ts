import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCommandEndpoint } from './commandEndpoint.ts'

test('Unix command endpoint preserves the existing socket location', () => {
  assert.deepEqual(
    resolveCommandEndpoint({ platform: 'darwin', yachiyoHome: '/Users/yuki/.yachiyo' }),
    {
      kind: 'unix-socket',
      address: '/Users/yuki/.yachiyo/yachiyo.sock'
    }
  )
})

test('Windows command endpoint is a stable named pipe scoped to YACHIYO_HOME', () => {
  const first = resolveCommandEndpoint({
    platform: 'win32',
    yachiyoHome: 'C:\\Users\\Yuki\\.yachiyo'
  })
  const repeated = resolveCommandEndpoint({
    platform: 'win32',
    yachiyoHome: 'C:\\Users\\Yuki\\.yachiyo'
  })
  const different = resolveCommandEndpoint({
    platform: 'win32',
    yachiyoHome: 'D:\\Portable\\Yachiyo Home'
  })

  assert.equal(first.kind, 'windows-pipe')
  assert.match(first.address, /^\\\\\.\\pipe\\yachiyo-[a-f0-9]{16}$/u)
  assert.equal(repeated.address, first.address)
  assert.notEqual(different.address, first.address)
})

test('Windows drive and path casing do not change the named pipe identity', () => {
  const upper = resolveCommandEndpoint({
    platform: 'win32',
    yachiyoHome: 'C:\\Users\\Yuki\\.Yachiyo\\'
  })
  const lower = resolveCommandEndpoint({
    platform: 'win32',
    yachiyoHome: 'c:\\users\\yuki\\.yachiyo'
  })

  assert.equal(upper.address, lower.address)
})
