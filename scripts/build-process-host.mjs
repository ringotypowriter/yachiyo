/* eslint-disable @typescript-eslint/explicit-function-return-type */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { resolveBuildExecutables } from './build-executables.mjs'

const ifChanged = process.argv.includes('--if-changed')
const rootDir = resolve(import.meta.dirname, '..')
const crateDir = join(rootDir, 'native', 'process-host')
const manifestPath = join(crateDir, 'Cargo.toml')
const generatedBindingPath = join(
  rootDir,
  'packages/runtime/src/services/processBroker/processHostProtocol.generated.ts'
)
const binaryName = resolveBuildExecutables(process.platform, rootDir).processHost
const releaseBinaryPath = join(crateDir, 'target', 'release', binaryName)
const osByPlatform = { darwin: 'mac', linux: 'linux', win32: 'win' }
const platformDir = `${osByPlatform[process.platform] ?? process.platform}-${process.arch}`
const outputDir = join(rootDir, 'apps', 'desktop', 'resources', 'bin', platformDir)
const outputPath = join(outputDir, binaryName)
const hashPath = join(outputDir, '.process-host.buildhash')

function hashInputs() {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(join(crateDir, 'src'))
  for (const extra of ['Cargo.toml', 'Cargo.lock']) {
    const path = join(crateDir, extra)
    if (existsSync(path)) files.push(path)
  }
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(crateDir, file).split(sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const currentHash = hashInputs()
if (
  ifChanged &&
  existsSync(outputPath) &&
  existsSync(generatedBindingPath) &&
  existsSync(hashPath) &&
  readFileSync(hashPath, 'utf8').trim() === currentHash
) {
  console.log('✓ process-host up to date (skipped rebuild)')
  process.exit(0)
}

if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error(
    '✗ cargo (Rust toolchain) is required to build process-host. Install from https://rustup.rs'
  )
  process.exit(1)
}

console.log('⟳ Generating process-host TypeScript protocol bindings...')
const generate = spawnSync(
  'cargo',
  ['run', '--quiet', '--manifest-path', manifestPath, '--bin', 'export-process-host-bindings'],
  { cwd: rootDir, env: process.env, stdio: 'inherit' }
)
if (generate.status !== 0) process.exit(generate.status ?? 1)

console.log(`⟳ Building process-host release binary for ${platformDir}...`)
const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', manifestPath, '--bin', 'process-host'],
  { cwd: rootDir, env: process.env, stdio: 'inherit' }
)
if (build.status !== 0) process.exit(build.status ?? 1)
if (!existsSync(releaseBinaryPath)) {
  console.error(`✗ process-host binary not found at ${releaseBinaryPath}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })
copyFileSync(releaseBinaryPath, outputPath)
chmodSync(outputPath, 0o755)
writeFileSync(hashPath, currentHash)
console.log(`✓ process-host → ${outputPath}`)
