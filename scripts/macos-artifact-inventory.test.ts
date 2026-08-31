import assert from 'node:assert/strict'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { inspectMacosArtifactInventory } from './macos-artifact-inventory.mjs'

test('macOS artifact inventory checks helpers, native modules, locales, and runtime assets', () => {
  const checked: string[] = []
  const report = inspectMacosArtifactInventory({
    appDir: '/staged/Yachiyo.app',
    arch: 'arm64',
    pathExists: (path: string) => {
      checked.push(path)
      return !path.includes('app.asar.unpacked') && !path.endsWith('/bin/uv')
    },
    readAsarEntries: () => [
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/chunks/drizzle/0000_initial.sql',
      '/out/main/jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: (path: string) =>
      path.endsWith('/sharp-libvips-darwin-arm64/lib')
        ? ['libvips-cpp.8.17.3.dylib']
        : ['en.lproj', 'zh_CN.lproj']
  })

  assert.deepEqual(report, { ok: true, missing: [] })
  for (const required of [
    '/Contents/MacOS/Yachiyo',
    '/bin/rg',
    '/bin/fd',
    '/bin/uv.runtime.gz',
    '/bin/rg.asset.json',
    '/bin/fd.asset.json',
    '/bin/uv.asset.json',
    '/licenses/uv-LICENSE-MIT',
    '/bin/sync-core',
    '/bin/process-host',
    '/external-hooks/vision-ocr',
    'better_sqlite3.node',
    'better-sqlite3/lib/index.js',
    'drizzle-orm/better-sqlite3/index.cjs',
    'drizzle-orm/better-sqlite3/migrator.cjs',
    'sharp-darwin-arm64.node',
    'sharp/lib/index.js',
    'bufferutil.node',
    'bufferutil/index.js',
    'utf-8-validate.node',
    'utf-8-validate/index.js',
    'zlib_sync.node',
    'zlib-sync/index.js',
    '@mixmark-io/domino/lib/index.js',
    'yachiyo-help/SKILL.md',
    'app.asar'
  ]) {
    assert.ok(
      checked.some((path) => path.includes(required)),
      `inventory did not check ${required}`
    )
  }
})

test('macOS artifact inventory reports missing runtime categories', () => {
  const report = inspectMacosArtifactInventory({
    appDir: '/staged/Yachiyo.app',
    arch: 'arm64',
    pathExists: () => false,
    readAsarEntries: () => [],
    readDirectory: () => []
  })

  assert.equal(report.ok, false)
  for (const category of [
    /Yachiyo executable/iu,
    /rg helper/iu,
    /fd helper/iu,
    /uv Python runtime archive/iu,
    /rg helper attestation/iu,
    /fd helper attestation/iu,
    /uv helper attestation/iu,
    /uv MIT license/iu,
    /sync-core/iu,
    /process-host/iu,
    /vision OCR/iu,
    /better-sqlite3/iu,
    /Drizzle SQLite adapter/iu,
    /Drizzle SQLite migrator/iu,
    /sharp native/iu,
    /bufferutil/iu,
    /utf-8-validate/iu,
    /zlib-sync/iu,
    /Domino/iu,
    /core skills/iu,
    /migrations/iu,
    /WASM/iu
  ]) {
    assert.ok(report.missing.some((entry: string) => category.test(entry)))
  }
})

test('macOS artifact inventory rejects duplicated and development-only payloads', () => {
  const report = inspectMacosArtifactInventory({
    appDir: '/staged/Yachiyo.app',
    arch: 'arm64',
    pathExists: () => true,
    readAsarEntries: () => [
      '/node_modules/mermaid/package.json',
      '/out/runtime-node-modules/node_modules/better-sqlite3/package.json',
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/drizzle/meta/0000_snapshot.json',
      '/out/main/runtime-host-spike.js',
      '/out/main/jieba_rs_wasm_bg.wasm'
    ],
    readDirectory: (path: string) =>
      path.endsWith('/sharp-libvips-darwin-arm64/lib')
        ? ['libvips-cpp.8.17.3.dylib']
        : ['de.lproj', 'en.lproj', 'zh_CN.lproj']
  })

  assert.equal(report.ok, false)
  assert.ok(report.missing.some((entry: string) => /root node_modules/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /staged runtime node_modules/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /Drizzle snapshots/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /runtime-host-spike/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /duplicated/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /raw uv helper/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /application locales/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /framework locales/iu.test(entry)))
})
