import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { resolveBuildExecutables, resolveBuildSpawnSpec } from './build-executables.mjs'

test('Windows build helpers resolve command shims and executable suffixes', () => {
  assert.deepEqual(resolveBuildExecutables('win32', 'C:\\source\\yachiyo'), {
    electron: 'C:\\source\\yachiyo\\node_modules\\.bin\\electron.cmd',
    pnpm: 'pnpm.cmd',
    syncCore: 'sync-core.exe'
  })
})

test('macOS build helper executable names remain unchanged', () => {
  assert.deepEqual(resolveBuildExecutables('darwin', '/source/yachiyo'), {
    electron: '/source/yachiyo/node_modules/.bin/electron',
    pnpm: 'pnpm',
    syncCore: 'sync-core'
  })
})

test('Windows command shims run through cmd.exe with escaped paths and arguments', () => {
  const spec = resolveBuildSpawnSpec(
    'win32',
    'C:\\source & tools\\yachiyo\\node_modules\\.bin\\electron.cmd',
    ['--module-dir', 'C:\\stage & cache\\runtime'],
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  )

  assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(spec.options.windowsVerbatimArguments, true)
  assert.match(spec.args[3], /electron\.cmd/u)
  assert.match(spec.args[3], /\^&/u)
  assert.doesNotMatch(spec.args[3], /(?<!\^)&/u)
})

test('POSIX build commands remain direct child-process invocations', () => {
  assert.deepEqual(resolveBuildSpawnSpec('darwin', '/repo/node_modules/.bin/electron', ['-p']), {
    command: '/repo/node_modules/.bin/electron',
    args: ['-p'],
    options: {}
  })
})

test('native dependency build scripts consume the shared command-shim adapter', async () => {
  for (const script of ['ensure-electron-native-deps.mjs', 'stage-runtime-node-modules.mjs']) {
    const source = await readFile(resolve(import.meta.dirname, script), 'utf8')
    assert.match(source, /resolveBuildSpawnSpec/u)
  }
})

test('desktop dev runner applies the Windows command-shim adapter before spawning', async () => {
  const source = await readFile(resolve(import.meta.dirname, 'run-desktop-dev.mjs'), 'utf8')

  assert.match(source, /resolveBuildSpawnSpec/u)
  assert.match(source, /spawn\(invocation\.command, invocation\.args/u)
})
