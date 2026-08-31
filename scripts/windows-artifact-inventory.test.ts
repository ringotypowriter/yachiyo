import assert from 'node:assert/strict'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { inspectWindowsArtifactInventory } from './windows-artifact-inventory.mjs'

test('Windows artifact inventory checks Bash, helpers, and native modules', () => {
  const checked: string[] = []
  const report = inspectWindowsArtifactInventory({
    appDir: 'C:\\staged',
    pathExists: (path: string) => {
      checked.push(path)
      return !path.includes('app.asar.unpacked') && !path.endsWith('\\bin\\uv.exe')
    },
    readAsarEntries: () => [
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/chunks/drizzle/0000_initial.sql',
      '/out/main/jieba_rs_wasm_bg.wasm',
      '/out/main/chunks/jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: () => ['en-US.pak', 'zh-CN.pak']
  })

  assert.deepEqual(report, { ok: true, missing: [] })
  for (const required of [
    'yachiyo.exe',
    'bash.exe',
    'env.exe',
    'git.exe',
    'PortableGit-LICENSE.txt',
    'python3',
    'rg.exe',
    'fd.exe',
    'uv.exe.runtime.gz',
    'rg.exe.asset.json',
    'fd.exe.asset.json',
    'uv.exe.asset.json',
    'uv-LICENSE-MIT',
    'sync-core.exe',
    'process-host.exe',
    'better_sqlite3.node',
    'better-sqlite3\\lib\\index.js',
    'drizzle-orm\\better-sqlite3\\index.cjs',
    'drizzle-orm\\better-sqlite3\\migrator.cjs',
    'sharp-win32-x64.node',
    'sharp\\lib\\index.js',
    'libvips-42.dll',
    'bufferutil.node',
    'bufferutil\\index.js',
    'utf-8-validate.node',
    'utf-8-validate\\index.js',
    'zlib_sync.node',
    'zlib-sync\\index.js',
    '@mixmark-io\\domino\\lib\\index.js',
    'yachiyo-help',
    'app.asar'
  ]) {
    assert.ok(
      checked.some((path) => path.includes(required)),
      `inventory did not check ${required}`
    )
  }
})

test('Windows artifact inventory accepts libvips bundled with sharp-win32-x64', () => {
  const checked: string[] = []
  const report = inspectWindowsArtifactInventory({
    appDir: 'C:\\staged',
    pathExists: (path: string) => {
      checked.push(path)
      if (path.includes('app.asar.unpacked')) return false
      if (path.endsWith('\\bin\\uv.exe')) return false
      if (!path.endsWith('libvips-42.dll')) return true
      return path.endsWith('@img\\sharp-win32-x64\\lib\\libvips-42.dll')
    },
    readAsarEntries: () => [
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: () => ['en-US.pak', 'zh-CN.pak']
  })

  assert.deepEqual(report, { ok: true, missing: [] })
  assert.ok(checked.some((path) => path.endsWith('@img\\sharp-win32-x64\\lib\\libvips-42.dll')))
})

test('Windows artifact inventory reports every missing category and a failing status', () => {
  const report = inspectWindowsArtifactInventory({
    appDir: 'C:\\staged',
    pathExists: () => false,
    readAsarEntries: () => []
  })

  assert.equal(report.ok, false)
  assert.ok(report.missing.some((entry: string) => /Yachiyo executable/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /PortableGit Bash/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /PortableGit license/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /python3/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /rg\.exe/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /fd\.exe/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /uv\.exe Python runtime archive/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /rg\.exe helper attestation/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /fd\.exe helper attestation/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /uv\.exe helper attestation/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /uv MIT license/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /sync-core/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /process-host/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /better-sqlite3/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /Drizzle SQLite adapter/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /Drizzle SQLite migrator/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /sharp/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /bufferutil/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /utf-8-validate/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /zlib-sync/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /Domino/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /core skills/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /migrations/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /WASM/iu.test(entry)))
})

test('Windows artifact inventory accepts the native packages published prebuild filenames', () => {
  const checked: string[] = []
  const report = inspectWindowsArtifactInventory({
    appDir: 'C:\\staged',
    pathExists: (path: string) => {
      checked.push(path)
      if (path.includes('app.asar.unpacked')) return false
      if (path.endsWith('\\bin\\uv.exe')) return false
      if (/bufferutil[\\/]build[\\/]Release/iu.test(path)) return false
      if (/utf-8-validate[\\/]build[\\/]Release/iu.test(path)) return false
      return !/node\.napi\.node$/iu.test(path)
    },
    readAsarEntries: () => [
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: () => ['en-US.pak', 'zh-CN.pak']
  })

  assert.equal(
    report.missing.some((entry: string) => /bufferutil|utf-8-validate/iu.test(entry)),
    false
  )
  assert.ok(checked.some((path) => path.endsWith('prebuilds\\win32-x64\\bufferutil.node')))
  assert.ok(checked.some((path) => path.endsWith('prebuilds\\win32-x64\\utf-8-validate.node')))
})

test('Windows artifact inventory accepts native ASAR path separators', () => {
  const report = inspectWindowsArtifactInventory({
    appDir: 'C:\\staged',
    pathExists: (path: string) =>
      !path.includes('app.asar.unpacked') && !path.endsWith('\\bin\\uv.exe'),
    readAsarEntries: () => [
      '\\out\\main\\drizzle\\0000_initial.sql',
      '\\out\\main\\jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: () => ['en-US.pak', 'zh-CN.pak']
  })

  assert.deepEqual(report, { ok: true, missing: [] })
})

test('Windows artifact inventory rejects duplicated and development-only payloads', () => {
  const report = inspectWindowsArtifactInventory({
    appDir: 'C:\\staged',
    pathExists: () => true,
    readAsarEntries: () => [
      '/node_modules/mermaid/package.json',
      '/out/runtime-node-modules/node_modules/better-sqlite3/package.json',
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/drizzle/meta/0000_snapshot.json',
      '/out/main/runtime-host-spike.js',
      '/out/main/jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: () => ['de.pak', 'en-US.pak', 'zh-CN.pak']
  })

  assert.equal(report.ok, false)
  assert.ok(report.missing.some((entry: string) => /root node_modules/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /staged runtime node_modules/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /Drizzle snapshots/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /runtime-host-spike/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /duplicated/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /raw uv\.exe helper/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /Electron locales/iu.test(entry)))
})
