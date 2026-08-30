#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

function readAppAsarEntries(appAsar) {
  const asar = require('@electron/asar')
  return asar.listPackage(appAsar)
}

function checkRequirement(pathExists, checked, missing, label, candidates) {
  checked.push(...candidates)
  if (!candidates.some((candidate) => pathExists(candidate))) {
    missing.push(`${label} (${candidates.join(' or ')})`)
  }
}

function checkLocales(pathExists, readDirectory, missing, directory, label) {
  if (!pathExists(directory)) return

  try {
    const actual = readDirectory(directory)
      .filter((entry) => entry.endsWith('.lproj'))
      .sort()
    const expected = ['en.lproj', 'zh_CN.lproj']
    if (
      actual.length !== expected.length ||
      actual.some((entry, index) => entry !== expected[index])
    ) {
      missing.push(`${label} must be ${expected.join(', ')}; found ${actual.join(', ')}`)
    }
  } catch (error) {
    missing.push(`${label} inventory (${error instanceof Error ? error.message : String(error)})`)
  }
}

export function inspectMacosArtifactInventory(input) {
  const pathExists = input.pathExists ?? existsSync
  const readDirectory = input.readDirectory ?? readdirSync
  const checked = []
  const contents = join(input.appDir, 'Contents')
  const resources = join(contents, 'Resources')
  const nodeModules = join(resources, 'node_modules')
  const appAsar = join(resources, 'app.asar')
  const unpackedBin = join(resources, 'app.asar.unpacked', 'resources', 'bin')
  const frameworkLocales = join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources')
  const arch = input.arch ?? process.arch
  const sharpPackage = `sharp-darwin-${arch}`
  const sharpLibvipsPackage = `sharp-libvips-darwin-${arch}`
  const sharpLibvipsDirectory = join(nodeModules, '@img', sharpLibvipsPackage, 'lib')
  const requirements = [
    ['Yachiyo executable', [join(contents, 'MacOS', 'Yachiyo')]],
    ['rg helper', [join(resources, 'bin', 'rg')]],
    ['fd helper', [join(resources, 'bin', 'fd')]],
    ['uv Python runtime helper', [join(resources, 'bin', 'uv')]],
    ['rg helper attestation', [join(resources, 'bin', 'rg.asset.json')]],
    ['fd helper attestation', [join(resources, 'bin', 'fd.asset.json')]],
    ['uv helper attestation', [join(resources, 'bin', 'uv.asset.json')]],
    ['uv MIT license', [join(resources, 'licenses', 'uv-LICENSE-MIT')]],
    ['sync-core helper', [join(resources, 'bin', 'sync-core')]],
    ['process-host helper', [join(resources, 'bin', 'process-host')]],
    ['vision OCR hook', [join(resources, 'external-hooks', 'vision-ocr')]],
    [
      'better-sqlite3 native module',
      [join(nodeModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')]
    ],
    [
      'better-sqlite3 JavaScript entrypoint',
      [join(nodeModules, 'better-sqlite3', 'lib', 'index.js')]
    ],
    ['Drizzle SQLite adapter', [join(nodeModules, 'drizzle-orm', 'better-sqlite3', 'index.cjs')]],
    [
      'Drizzle SQLite migrator',
      [join(nodeModules, 'drizzle-orm', 'better-sqlite3', 'migrator.cjs')]
    ],
    ['Domino runtime entrypoint', [join(nodeModules, '@mixmark-io', 'domino', 'lib', 'index.js')]],
    [
      'sharp native module',
      [join(nodeModules, '@img', sharpPackage, 'lib', `${sharpPackage}.node`)]
    ],
    ['sharp JavaScript entrypoint', [join(nodeModules, 'sharp', 'lib', 'index.js')]],
    [
      'bufferutil native module',
      [
        join(nodeModules, 'bufferutil', 'prebuilds', `darwin-${arch}`, 'bufferutil.node'),
        join(nodeModules, 'bufferutil', 'build', 'Release', 'bufferutil.node')
      ]
    ],
    ['bufferutil JavaScript entrypoint', [join(nodeModules, 'bufferutil', 'index.js')]],
    [
      'utf-8-validate native module',
      [
        join(nodeModules, 'utf-8-validate', 'prebuilds', `darwin-${arch}`, 'utf-8-validate.node'),
        join(nodeModules, 'utf-8-validate', 'build', 'Release', 'validation.node')
      ]
    ],
    ['utf-8-validate JavaScript entrypoint', [join(nodeModules, 'utf-8-validate', 'index.js')]],
    [
      'zlib-sync native module',
      [join(nodeModules, 'zlib-sync', 'build', 'Release', 'zlib_sync.node')]
    ],
    ['zlib-sync JavaScript entrypoint', [join(nodeModules, 'zlib-sync', 'index.js')]],
    ['core skills catalog', [join(resources, 'core-skills', 'yachiyo-help', 'SKILL.md')]],
    ['application locale directory', [resources]],
    ['Electron framework locale directory', [frameworkLocales]],
    ['app.asar', [appAsar]]
  ]

  const missing = []
  for (const [label, candidates] of requirements) {
    checkRequirement(pathExists, checked, missing, label, candidates)
  }

  if (pathExists(sharpLibvipsDirectory)) {
    try {
      if (!readDirectory(sharpLibvipsDirectory).some((entry) => entry.endsWith('.dylib'))) {
        missing.push(`sharp libvips dylib (${sharpLibvipsDirectory})`)
      }
    } catch (error) {
      missing.push(
        `sharp libvips inventory (${error instanceof Error ? error.message : String(error)})`
      )
    }
  } else {
    missing.push(`sharp libvips directory (${sharpLibvipsDirectory})`)
  }

  let asarEntries = []
  if (pathExists(appAsar)) {
    try {
      asarEntries = input.readAsarEntries(appAsar)
    } catch (error) {
      missing.push(`readable app.asar (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (!asarEntries.some((entry) => /[\\/]drizzle[\\/].*\.sql$/iu.test(entry))) {
    missing.push('Drizzle migrations in app.asar')
  }
  if (!asarEntries.some((entry) => /\.wasm$/iu.test(entry))) {
    missing.push('WASM assets in app.asar')
  }
  if (asarEntries.some((entry) => /^[\\/]node_modules[\\/]/u.test(entry))) {
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

  checkLocales(pathExists, readDirectory, missing, resources, 'application locales')
  checkLocales(pathExists, readDirectory, missing, frameworkLocales, 'Electron framework locales')

  return { ok: missing.length === 0, missing }
}

function parseAppDir(args) {
  const index = args.indexOf('--app-dir')
  if (index >= 0 && args[index + 1]) return resolve(args[index + 1])

  const dist = resolve(process.cwd(), 'dist')
  for (const directory of ['mac-arm64', 'mac-x64', 'mac', 'mac-universal']) {
    const candidate = join(dist, directory, 'Yachiyo.app')
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Cannot find packaged Yachiyo.app under ${dist}`)
}

function main() {
  const appDir = parseAppDir(process.argv.slice(2))
  const report = inspectMacosArtifactInventory({
    appDir,
    pathExists: existsSync,
    readAsarEntries: readAppAsarEntries,
    readDirectory: readdirSync
  })
  if (!report.ok) {
    console.error(`macOS artifact inventory failed:\n- ${report.missing.join('\n- ')}`)
    process.exitCode = 1
    return
  }
  console.log(`macOS artifact inventory passed: ${appDir}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
