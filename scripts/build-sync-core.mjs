/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import process from 'node:process'

const rootDir = resolve(import.meta.dirname, '..')
const manifestPath = join(rootDir, 'native', 'sync-core', 'Cargo.toml')
const binaryName = process.platform === 'win32' ? 'sync-core.exe' : 'sync-core'
const releaseBinaryPath = join(rootDir, 'native', 'sync-core', 'target', 'release', binaryName)

const EB_OS_MAP = { darwin: 'mac', linux: 'linux', win32: 'win' }
const os = EB_OS_MAP[process.platform] ?? process.platform
const platformDir = `${os}-${process.arch}`
const outputDir = join(rootDir, 'apps', 'desktop', 'resources', 'bin', platformDir)
const outputPath = join(outputDir, binaryName)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log(`⟳ Building sync-core release binary for ${platformDir}...`)
run('cargo', ['build', '--release', '--manifest-path', manifestPath])

if (!existsSync(releaseBinaryPath)) {
  console.error(`✗ sync-core binary not found at ${releaseBinaryPath}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })
copyFileSync(releaseBinaryPath, outputPath)
chmodSync(outputPath, 0o755)
console.log(`✓ sync-core → ${outputPath}`)
