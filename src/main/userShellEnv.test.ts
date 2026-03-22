import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeShellEnv, parseShellEnvOutput } from './userShellEnv'

test('parseShellEnvOutput reads null-separated shell env output and drops volatile keys', () => {
  const result = parseShellEnvOutput(
    'PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/ringo\0PWD=/tmp/demo\0SHLVL=2\0\0'
  )

  assert.deepEqual(result, {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/ringo'
  })
})

test('mergeShellEnv overlays shell values onto the existing process environment', () => {
  const result = mergeShellEnv(
    {
      PATH: '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '0'
    },
    {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOMEBREW_PREFIX: '/opt/homebrew'
    }
  )

  assert.deepEqual(result, {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '0',
    HOMEBREW_PREFIX: '/opt/homebrew'
  })
})
