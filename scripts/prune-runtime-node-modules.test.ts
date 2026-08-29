import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { pruneStagedRuntimeNodeModules } from './prune-runtime-node-modules.mjs'

async function writeFixture(path: string, content = 'fixture'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

test('runtime staging keeps executable files while removing build-only payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-runtime-prune-'))
  const nodeModulesDir = join(root, 'node_modules')

  try {
    await Promise.all([
      writeFixture(
        join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
        'sqlite-native'
      ),
      writeFixture(
        join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', 'obj.target', 'sqlite.o')
      ),
      writeFixture(join(nodeModulesDir, 'better-sqlite3', 'deps', 'sqlite3.c')),
      writeFixture(join(nodeModulesDir, 'better-sqlite3', 'src', 'better_sqlite3.cpp')),
      writeFixture(join(nodeModulesDir, 'better-sqlite3', 'binding.gyp')),
      writeFixture(join(nodeModulesDir, 'better-sqlite3', 'LICENSE')),
      writeFixture(
        join(nodeModulesDir, 'zlib-sync', 'build', 'Release', 'zlib_sync.node'),
        'zlib-native'
      ),
      writeFixture(join(nodeModulesDir, 'zlib-sync', 'build', 'Release', 'obj.target', 'zlib.o')),
      writeFixture(join(nodeModulesDir, 'zlib-sync', 'deps', 'zlib.c')),
      writeFixture(join(nodeModulesDir, 'zlib-sync', 'src', 'binding.cc')),
      writeFixture(join(nodeModulesDir, 'zlib-sync', 'binding.gyp')),
      writeFixture(join(nodeModulesDir, 'zlib-sync', 'LICENSE')),
      writeFixture(join(nodeModulesDir, '@mixmark-io', 'domino', 'lib', 'index.js')),
      writeFixture(join(nodeModulesDir, '@mixmark-io', 'domino', 'test', 'domino.test.js')),
      writeFixture(join(nodeModulesDir, '@mixmark-io', 'domino', '.yarn', 'releases', 'yarn.cjs')),
      writeFixture(join(nodeModulesDir, '@mixmark-io', 'domino', 'LICENSE')),
      writeFixture(
        join(nodeModulesDir, 'bufferutil', 'prebuilds', 'darwin-arm64', 'bufferutil.node')
      ),
      writeFixture(join(nodeModulesDir, 'bufferutil', 'prebuilds', 'win32-x64', 'bufferutil.node')),
      writeFixture(
        join(nodeModulesDir, 'utf-8-validate', 'prebuilds', 'darwin-arm64', 'utf-8-validate.node')
      ),
      writeFixture(
        join(nodeModulesDir, 'utf-8-validate', 'prebuilds', 'linux-x64', 'utf-8-validate.node')
      )
    ])

    const report = pruneStagedRuntimeNodeModules(nodeModulesDir, {
      platform: 'darwin',
      arch: 'arm64'
    })

    assert.equal(
      await readFile(
        join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
        'utf8'
      ),
      'sqlite-native'
    )
    assert.equal(
      await readFile(
        join(nodeModulesDir, 'zlib-sync', 'build', 'Release', 'zlib_sync.node'),
        'utf8'
      ),
      'zlib-native'
    )
    assert.equal(
      existsSync(
        join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', 'obj.target', 'sqlite.o')
      ),
      false
    )
    assert.equal(existsSync(join(nodeModulesDir, 'better-sqlite3', 'deps')), false)
    assert.equal(existsSync(join(nodeModulesDir, 'zlib-sync', 'src')), false)
    assert.equal(existsSync(join(nodeModulesDir, '@mixmark-io', 'domino', 'test')), false)
    assert.equal(existsSync(join(nodeModulesDir, '@mixmark-io', 'domino', '.yarn')), false)
    assert.equal(existsSync(join(nodeModulesDir, '@mixmark-io', 'domino', 'lib', 'index.js')), true)
    assert.equal(existsSync(join(nodeModulesDir, '@mixmark-io', 'domino', 'LICENSE')), true)
    assert.equal(
      existsSync(
        join(nodeModulesDir, 'bufferutil', 'prebuilds', 'darwin-arm64', 'bufferutil.node')
      ),
      true
    )
    assert.equal(existsSync(join(nodeModulesDir, 'bufferutil', 'prebuilds', 'win32-x64')), false)
    assert.equal(
      existsSync(
        join(nodeModulesDir, 'utf-8-validate', 'prebuilds', 'darwin-arm64', 'utf-8-validate.node')
      ),
      true
    )
    assert.equal(
      existsSync(join(nodeModulesDir, 'utf-8-validate', 'prebuilds', 'linux-x64')),
      false
    )
    assert.deepEqual(report.compactedNativeBuilds, [
      'better-sqlite3/build/Release/better_sqlite3.node',
      'zlib-sync/build/Release/zlib_sync.node'
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime staging fails before pruning when a rebuilt native artifact is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-runtime-prune-missing-'))
  const nodeModulesDir = join(root, 'node_modules')

  try {
    await writeFixture(join(nodeModulesDir, 'better-sqlite3', 'src', 'better_sqlite3.cpp'))

    assert.throws(
      () => pruneStagedRuntimeNodeModules(nodeModulesDir),
      /rebuilt artifact .*better_sqlite3\.node is missing/u
    )
    assert.equal(existsSync(join(nodeModulesDir, 'better-sqlite3', 'src')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
