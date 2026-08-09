import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import {
  ELECTRON_REBUILD_MODULES,
  RUNTIME_NATIVE_MODULES,
  buildRuntimeNativeModuleProbe
} from './runtime-native-modules.mjs'

test('runtime native module contract includes every packaged Electron dependency', () => {
  assert.deepEqual(RUNTIME_NATIVE_MODULES, [
    'better-sqlite3',
    'sharp',
    'bufferutil',
    'utf-8-validate',
    'zlib-sync'
  ])
  assert.deepEqual(ELECTRON_REBUILD_MODULES, ['better-sqlite3', 'zlib-sync'])
})

test('native module probe exercises SQLite and sharp without swallowing load failures', () => {
  const probe = buildRuntimeNativeModuleProbe('C:\\staged & runtime')

  for (const packageName of RUNTIME_NATIVE_MODULES) {
    assert.ok(probe.includes(packageName), `${packageName} is missing from the probe`)
  }
  assert.match(probe, /new Database\(':memory:'\)/u)
  assert.match(probe, /\.png\(\)\.toBuffer\(\)/u)
  assert.match(probe, /process\.exitCode = 1/u)
})

test('native module probe rejects JavaScript fallbacks when a native binding is missing', async () => {
  const moduleRoot = await mkdtemp(join(tmpdir(), 'yachiyo-native-probe-'))
  const nodeModules = join(moduleRoot, 'node_modules')

  try {
    await writeFile(join(moduleRoot, 'package.json'), '{}')

    const fixtures: Record<string, Record<string, string>> = {
      'better-sqlite3': {
        'index.js': 'module.exports = class Database { close() {} }'
      },
      sharp: {
        'index.js':
          'module.exports = () => ({ png: () => ({ toBuffer: async () => Buffer.alloc(0) }) })'
      },
      bufferutil: {
        'index.js':
          "try { module.exports = require('node-gyp-build')(__dirname) } catch { module.exports = require('./fallback') }",
        'fallback.js': 'module.exports = {}'
      },
      'utf-8-validate': {
        'index.js':
          "try { module.exports = require('node-gyp-build')(__dirname) } catch { module.exports = require('./fallback') }",
        'fallback.js': 'module.exports = () => true'
      },
      'zlib-sync': {
        'index.js': 'module.exports = {}'
      }
    }

    for (const [packageName, files] of Object.entries(fixtures)) {
      const packageDir = join(nodeModules, packageName)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: packageName }))
      await Promise.all(
        Object.entries(files).map(([filename, source]) =>
          writeFile(join(packageDir, filename), source)
        )
      )
    }

    const result = spawnSync(process.execPath, ['-e', buildRuntimeNativeModuleProbe(moduleRoot)], {
      encoding: 'utf8'
    })

    assert.notEqual(result.status, 0, 'missing native bindings must fail the probe')
  } finally {
    await rm(moduleRoot, { recursive: true, force: true })
  }
})

test('desktop declares optional runtime loads as required packaging dependencies', async () => {
  const desktopPackage = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../apps/desktop/package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> }
  const rootPackage = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')
  ) as { pnpm?: { onlyBuiltDependencies?: string[] } }

  for (const packageName of ['bufferutil', 'utf-8-validate', 'zlib-sync']) {
    assert.ok(
      desktopPackage.dependencies?.[packageName],
      `${packageName} must be a direct dependency`
    )
    assert.ok(
      rootPackage.pnpm?.onlyBuiltDependencies?.includes(packageName),
      `${packageName} install scripts must be explicitly allowed`
    )
  }
})

test('prepare and staging scripts consume the shared native-module contract', async () => {
  for (const script of ['ensure-electron-native-deps.mjs', 'stage-runtime-node-modules.mjs']) {
    const source = await readFile(resolve(import.meta.dirname, script), 'utf8')
    assert.match(source, /runtime-native-modules\.mjs/u)
    assert.match(source, /buildRuntimeNativeModuleProbe/u)
  }
})
