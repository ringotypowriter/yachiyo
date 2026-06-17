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

// `--if-changed`: skip the rebuild when sources are unchanged and degrade
// gracefully when cargo is absent. Used by `pnpm dev` so the running app never
// loads a stale staged binary, without forcing every contributor to have Rust.
const ifChanged = process.argv.includes('--if-changed')

const rootDir = resolve(import.meta.dirname, '..')
const crateDir = join(rootDir, 'native', 'sync-core')
const manifestPath = join(crateDir, 'Cargo.toml')
const binaryName = process.platform === 'win32' ? 'sync-core.exe' : 'sync-core'
const releaseBinaryPath = join(crateDir, 'target', 'release', binaryName)

const EB_OS_MAP = { darwin: 'mac', linux: 'linux', win32: 'win' }
const os = EB_OS_MAP[process.platform] ?? process.platform
const platformDir = `${os}-${process.arch}`
const outputDir = join(rootDir, 'apps', 'desktop', 'resources', 'bin', platformDir)
const outputPath = join(outputDir, binaryName)
const hashPath = join(outputDir, '.sync-core.buildhash')

function hashInputs() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(join(crateDir, 'src'))
  for (const extra of ['Cargo.toml', 'Cargo.lock']) {
    const full = join(crateDir, extra)
    if (existsSync(full)) files.push(full)
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

function hasCargo() {
  return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
}

const currentHash = hashInputs()

if (
  ifChanged &&
  existsSync(outputPath) &&
  existsSync(hashPath) &&
  readFileSync(hashPath, 'utf8').trim() === currentHash
) {
  console.log('✓ sync-core up to date (skipped rebuild)')
  process.exit(0)
}

if (!hasCargo()) {
  if (ifChanged) {
    console.warn(
      existsSync(outputPath)
        ? '⚠ sync-core sources changed but cargo is not installed — keeping the existing staged binary. Install Rust and run `pnpm run sync-core:build` for the latest.'
        : '⚠ sync-core binary missing and cargo is not installed — iCloud sync will be unavailable until you install Rust and run `pnpm run sync-core:build`.'
    )
    process.exit(0)
  }
  console.error(
    '✗ cargo (Rust toolchain) is required to build sync-core. Install from https://rustup.rs'
  )
  process.exit(1)
}

console.log(`⟳ Building sync-core release binary for ${platformDir}...`)
const build = spawnSync('cargo', ['build', '--release', '--manifest-path', manifestPath], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit'
})
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

if (!existsSync(releaseBinaryPath)) {
  console.error(`✗ sync-core binary not found at ${releaseBinaryPath}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })
copyFileSync(releaseBinaryPath, outputPath)
chmodSync(outputPath, 0o755)
writeFileSync(hashPath, currentHash)
console.log(`✓ sync-core → ${outputPath}`)
