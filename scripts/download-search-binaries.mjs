/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Downloads pinned versions of ripgrep (rg) and fd for the current macOS
 * platform. Outputs binaries to resources/bin/{platform}-{arch}/.
 *
 * Usage:
 *   node scripts/download-search-binaries.mjs           # download for current arch
 *   node scripts/download-search-binaries.mjs --force    # re-download even if binaries exist
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execSync } from 'node:child_process'
import process from 'node:process'

// ── Pinned versions ──────────────────────────────────────────────────────────

const RG_VERSION = '15.1.0'
const FD_VERSION = '10.4.2'

// ── Platform mapping ─────────────────────────────────────────────────────────

const PLATFORM = process.platform
const ARCH = process.arch

if (PLATFORM !== 'darwin') {
  console.log(`⏭ Skipping search binary download — only macOS is supported (got ${PLATFORM})`)
  process.exit(0)
}

const DARWIN_ARCH_MAP = {
  arm64: 'aarch64-apple-darwin',
  x64: 'x86_64-apple-darwin'
}

const darwinTarget = DARWIN_ARCH_MAP[ARCH]
if (!darwinTarget) {
  console.error(`✗ Unsupported architecture: ${ARCH}`)
  process.exit(1)
}

// Use electron-builder's ${os} naming: mac, linux, win (not process.platform values).
const EB_OS_MAP = { darwin: 'mac', linux: 'linux', win32: 'win' }
const platformDir = `${EB_OS_MAP[PLATFORM]}-${ARCH}`

// ── Paths ────────────────────────────────────────────────────────────────────

const rootDir = resolve(import.meta.dirname, '..')
const outputDir = resolve(rootDir, 'resources', 'bin', platformDir)
const rgOutputPath = join(outputDir, 'rg')
const fdOutputPath = join(outputDir, 'fd')
const force = process.argv.includes('--force')

// ── Helpers ──────────────────────────────────────────────────────────────────

async function download(url, destPath) {
  console.log(`  ↓ ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`)
  }

  const fileStream = createWriteStream(destPath)
  await pipeline(response.body, fileStream)
}

function extractTarGz(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true })
  execSync(`tar xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(destDir)}`, {
    stdio: 'pipe'
  })
}

// ── Download ripgrep ─────────────────────────────────────────────────────────

async function downloadRipgrep() {
  if (!force && existsSync(rgOutputPath)) {
    console.log(`✓ rg already exists at ${rgOutputPath}`)
    return
  }

  console.log(`⟳ Downloading ripgrep ${RG_VERSION} for ${darwinTarget}...`)

  const archiveName = `ripgrep-${RG_VERSION}-${darwinTarget}.tar.gz`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}`
  const tmpDir = join(tmpdir(), `yachiyo-rg-${Date.now()}`)
  const archivePath = join(tmpDir, archiveName)

  mkdirSync(tmpDir, { recursive: true })

  try {
    await download(url, archivePath)
    extractTarGz(archivePath, tmpDir)

    const extractedDir = join(tmpDir, `ripgrep-${RG_VERSION}-${darwinTarget}`)
    const rgBinary = join(extractedDir, 'rg')

    if (!existsSync(rgBinary)) {
      throw new Error(`rg binary not found at expected path: ${rgBinary}`)
    }

    mkdirSync(outputDir, { recursive: true })
    renameSync(rgBinary, rgOutputPath)
    chmodSync(rgOutputPath, 0o755)

    console.log(`✓ rg ${RG_VERSION} → ${rgOutputPath}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── Download fd ──────────────────────────────────────────────────────────────

async function downloadFd() {
  if (!force && existsSync(fdOutputPath)) {
    console.log(`✓ fd already exists at ${fdOutputPath}`)
    return
  }

  console.log(`⟳ Downloading fd ${FD_VERSION} for ${darwinTarget}...`)

  const archiveName = `fd-v${FD_VERSION}-${darwinTarget}.tar.gz`
  const url = `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${archiveName}`
  const tmpDir = join(tmpdir(), `yachiyo-fd-${Date.now()}`)
  const archivePath = join(tmpDir, archiveName)

  mkdirSync(tmpDir, { recursive: true })

  try {
    await download(url, archivePath)
    extractTarGz(archivePath, tmpDir)

    const extractedDir = join(tmpDir, `fd-v${FD_VERSION}-${darwinTarget}`)
    const fdBinary = join(extractedDir, 'fd')

    if (!existsSync(fdBinary)) {
      throw new Error(`fd binary not found at expected path: ${fdBinary}`)
    }

    mkdirSync(outputDir, { recursive: true })
    renameSync(fdBinary, fdOutputPath)
    chmodSync(fdOutputPath, 0o755)

    console.log(`✓ fd ${FD_VERSION} → ${fdOutputPath}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSearch binary setup (${platformDir})\n`)

  await downloadRipgrep()
  await downloadFd()

  console.log('\nDone.\n')
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`)
  process.exit(1)
})
