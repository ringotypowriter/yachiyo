#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync, readdirSync } from 'node:fs'
import { win32 } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { listPackage } from '@electron/asar'

function firstExisting(candidates, pathExists, checked) {
  for (const candidate of candidates) {
    checked.push(candidate)
    if (pathExists(candidate)) return candidate
  }
  return undefined
}

export function inspectWindowsArtifactInventory(input) {
  const pathExists = input.pathExists ?? existsSync
  const readDirectory = input.readDirectory ?? readdirSync
  const checked = []
  const resources = win32.join(input.appDir, 'resources')
  const bin = win32.join(resources, 'bin')
  const nodeModules = win32.join(resources, 'node_modules')
  const appAsar = win32.join(resources, 'app.asar')
  const unpackedBin = win32.join(resources, 'app.asar.unpacked', 'resources', 'bin')
  const locales = win32.join(input.appDir, 'locales')
  const requirements = [
    ['Yachiyo executable', [win32.join(input.appDir, 'yachiyo.exe')]],
    ['PortableGit Bash', [win32.join(bin, 'bash', 'usr', 'bin', 'bash.exe')]],
    ['PortableGit env', [win32.join(bin, 'bash', 'usr', 'bin', 'env.exe')]],
    ['PortableGit runtime DLL', [win32.join(bin, 'bash', 'usr', 'bin', 'msys-2.0.dll')]],
    ['PortableGit Git', [win32.join(bin, 'bash', 'mingw64', 'bin', 'git.exe')]],
    ['PortableGit runtime marker', [win32.join(bin, 'bash', '.yachiyo-runtime.json')]],
    ['PortableGit license', [win32.join(bin, 'bash', 'licenses', 'PortableGit-LICENSE.txt')]],
    ['python3 compatibility shim', [win32.join(bin, 'python3')]],
    ['rg.exe search helper', [win32.join(bin, 'rg.exe')]],
    ['fd.exe search helper', [win32.join(bin, 'fd.exe')]],
    ['uv.exe Python runtime archive', [win32.join(bin, 'uv.exe.runtime.gz')]],
    ['rg.exe helper attestation', [win32.join(bin, 'rg.exe.asset.json')]],
    ['fd.exe helper attestation', [win32.join(bin, 'fd.exe.asset.json')]],
    ['uv.exe helper attestation', [win32.join(bin, 'uv.exe.asset.json')]],
    ['uv MIT license', [win32.join(resources, 'licenses', 'uv-LICENSE-MIT')]],
    ['sync-core.exe helper', [win32.join(bin, 'sync-core.exe')]],
    ['process-host.exe resident helper', [win32.join(bin, 'process-host.exe')]],
    [
      'better-sqlite3 native module',
      [win32.join(nodeModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')]
    ],
    [
      'better-sqlite3 JavaScript entrypoint',
      [win32.join(nodeModules, 'better-sqlite3', 'lib', 'index.js')]
    ],
    [
      'Drizzle SQLite adapter',
      [win32.join(nodeModules, 'drizzle-orm', 'better-sqlite3', 'index.cjs')]
    ],
    [
      'Drizzle SQLite migrator',
      [win32.join(nodeModules, 'drizzle-orm', 'better-sqlite3', 'migrator.cjs')]
    ],
    [
      'Domino runtime entrypoint',
      [win32.join(nodeModules, '@mixmark-io', 'domino', 'lib', 'index.js')]
    ],
    [
      'sharp native module',
      [
        win32.join(nodeModules, '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node'),
        win32.join(nodeModules, 'sharp', 'build', 'Release', 'sharp-win32-x64.node')
      ]
    ],
    ['sharp JavaScript entrypoint', [win32.join(nodeModules, 'sharp', 'lib', 'index.js')]],
    [
      'sharp libvips runtime',
      [
        win32.join(nodeModules, '@img', 'sharp-win32-x64', 'lib', 'libvips-42.dll'),
        win32.join(nodeModules, 'sharp', 'vendor', 'lib', 'libvips-42.dll')
      ]
    ],
    [
      'bufferutil native module',
      [
        win32.join(nodeModules, 'bufferutil', 'build', 'Release', 'bufferutil.node'),
        win32.join(nodeModules, 'bufferutil', 'prebuilds', 'win32-x64', 'bufferutil.node')
      ]
    ],
    ['bufferutil JavaScript entrypoint', [win32.join(nodeModules, 'bufferutil', 'index.js')]],
    [
      'utf-8-validate native module',
      [
        win32.join(nodeModules, 'utf-8-validate', 'build', 'Release', 'utf-8-validate.node'),
        win32.join(nodeModules, 'utf-8-validate', 'prebuilds', 'win32-x64', 'utf-8-validate.node')
      ]
    ],
    [
      'utf-8-validate JavaScript entrypoint',
      [win32.join(nodeModules, 'utf-8-validate', 'index.js')]
    ],
    [
      'zlib-sync native module',
      [win32.join(nodeModules, 'zlib-sync', 'build', 'Release', 'zlib_sync.node')]
    ],
    ['zlib-sync JavaScript entrypoint', [win32.join(nodeModules, 'zlib-sync', 'index.js')]],
    ['core skills catalog', [win32.join(resources, 'core-skills', 'yachiyo-help', 'SKILL.md')]],
    ['Electron locale directory', [locales]],
    ['app.asar', [appAsar]]
  ]

  const missing = []
  for (const [label, candidates] of requirements) {
    if (!firstExisting(candidates, pathExists, checked)) missing.push(label)
  }

  let asarEntries = []
  if (pathExists(appAsar)) {
    try {
      asarEntries = input.readAsarEntries(appAsar)
    } catch (error) {
      missing.push(`app.asar inventory (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (!asarEntries.some((entry) => /drizzle[\\/].*\.sql$/iu.test(entry))) {
    missing.push('database migrations in app.asar')
  }
  if (!asarEntries.some((entry) => /\.wasm$/iu.test(entry))) {
    missing.push('WASM assets in app.asar')
  }
  if (asarEntries.some((entry) => /^[\\/]+node_modules[\\/]/u.test(entry))) {
    missing.push('root node_modules must not be bundled in app.asar')
  }
  if (asarEntries.some((entry) => /[\\/]runtime-node-modules[\\/]/u.test(entry))) {
    missing.push('staged runtime node_modules must not be bundled in app.asar')
  }
  if (asarEntries.some((entry) => /_snapshot\.json$/u.test(entry))) {
    missing.push('Drizzle snapshots must not be bundled in app.asar')
  }
  if (asarEntries.some((entry) => /(^|[\\/])runtime-host-spike\.js$/u.test(entry))) {
    missing.push('runtime-host-spike.js must not be bundled in app.asar')
  }
  if (pathExists(unpackedBin)) {
    missing.push('runtime bin must not be duplicated under app.asar.unpacked')
  }
  if (pathExists(win32.join(bin, 'uv.exe'))) {
    missing.push('raw uv.exe helper must not be packaged; use the attested runtime archive')
  }
  if (pathExists(locales)) {
    try {
      const actualLocales = readDirectory(locales)
        .filter((entry) => entry.endsWith('.pak'))
        .sort()
      const expectedLocales = ['en-US.pak', 'zh-CN.pak']
      if (
        actualLocales.length !== expectedLocales.length ||
        actualLocales.some((entry, index) => entry !== expectedLocales[index])
      ) {
        missing.push(
          `Electron locales must be ${expectedLocales.join(', ')}; found ${actualLocales.join(', ')}`
        )
      }
    } catch (error) {
      missing.push(
        `Electron locale inventory (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  return { ok: missing.length === 0, missing }
}

function readAppAsarEntries(path) {
  return listPackage(path, { isPack: false })
}

function parseAppDir(args) {
  const index = args.indexOf('--app-dir')
  if (index >= 0 && args[index + 1]) return win32.resolve(args[index + 1])
  return win32.resolve(process.cwd(), 'dist', 'win-unpacked')
}

function main() {
  const appDir = parseAppDir(process.argv.slice(2))
  const report = inspectWindowsArtifactInventory({
    appDir,
    pathExists: existsSync,
    readAsarEntries: readAppAsarEntries,
    readDirectory: readdirSync
  })
  if (!report.ok) {
    console.error(`Windows artifact inventory failed:\n- ${report.missing.join('\n- ')}`)
    process.exitCode = 1
    return
  }
  console.log(`Windows artifact inventory passed: ${appDir}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
