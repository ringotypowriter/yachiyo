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
      return true
    },
    readAsarEntries: () => [
      '/out/main/drizzle/0000_initial.sql',
      '/out/main/chunks/drizzle/0000_initial.sql',
      '/out/main/jieba_rs_wasm_bg.wasm',
      '/out/main/chunks/jieba_rs_wasm_bg.wasm'
    ]
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
    'sync-core.exe',
    'better_sqlite3.node',
    'sharp-win32-x64.node',
    'libvips-42.dll',
    'bufferutil.node',
    'utf-8-validate.node',
    'zlib_sync.node',
    'yachiyo-help',
    'app.asar'
  ]) {
    assert.ok(
      checked.some((path) => path.includes(required)),
      `inventory did not check ${required}`
    )
  }
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
  assert.ok(report.missing.some((entry: string) => /sync-core/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /better-sqlite3/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /sharp/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /bufferutil/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /utf-8-validate/iu.test(entry)))
  assert.ok(report.missing.some((entry: string) => /zlib-sync/iu.test(entry)))
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
      if (/bufferutil[\\/]build[\\/]Release/iu.test(path)) return false
      if (/utf-8-validate[\\/]build[\\/]Release/iu.test(path)) return false
      return !/node\.napi\.node$/iu.test(path)
    },
    readAsarEntries: () => ['/out/main/drizzle/0000_initial.sql', '/out/main/jieba_rs_wasm_bg.wasm']
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
    pathExists: () => true,
    readAsarEntries: () => [
      '\\out\\main\\drizzle\\0000_initial.sql',
      '\\out\\main\\jieba_rs_wasm_bg.wasm'
    ]
  })

  assert.deepEqual(report, { ok: true, missing: [] })
})
