/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Downloads and builds pinned versions of ripgrep (rg) and bfs for the current
 * macOS platform. Outputs binaries to resources/bin/{platform}-{arch}/.
 *
 * Usage:
 *   node scripts/download-search-binaries.mjs           # build for current arch
 *   node scripts/download-search-binaries.mjs --force    # re-download even if binaries exist
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execSync, spawnSync } from 'node:child_process'
import process from 'node:process'

// ── Pinned versions ──────────────────────────────────────────────────────────

const RG_VERSION = '15.1.0'
const BFS_VERSION = '4.1'

// ── Platform mapping ─────────────────────────────────────────────────────────

const PLATFORM = process.platform
const ARCH = process.arch

if (PLATFORM !== 'darwin') {
  console.log(`⏭ Skipping search binary download — only macOS is supported (got ${PLATFORM})`)
  process.exit(0)
}

const RG_ARCH_MAP = {
  arm64: 'aarch64-apple-darwin',
  x64: 'x86_64-apple-darwin'
}

const rgTarget = RG_ARCH_MAP[ARCH]
if (!rgTarget) {
  console.error(`✗ Unsupported architecture: ${ARCH}`)
  process.exit(1)
}

const platformDir = `${PLATFORM}-${ARCH}`

// ── Paths ────────────────────────────────────────────────────────────────────

const rootDir = resolve(import.meta.dirname, '..')
const outputDir = resolve(rootDir, 'resources', 'bin', platformDir)
const rgOutputPath = join(outputDir, 'rg')
const bfsOutputPath = join(outputDir, 'bfs')
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || result.error?.message || 'unknown error'
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`)
  }
  return result
}

// ── Download ripgrep ─────────────────────────────────────────────────────────

async function downloadRipgrep() {
  if (!force && existsSync(rgOutputPath)) {
    console.log(`✓ rg already exists at ${rgOutputPath}`)
    return
  }

  console.log(`⟳ Downloading ripgrep ${RG_VERSION} for ${rgTarget}...`)

  const archiveName = `ripgrep-${RG_VERSION}-${rgTarget}.tar.gz`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}`
  const tmpDir = join(tmpdir(), `yachiyo-rg-${Date.now()}`)
  const archivePath = join(tmpDir, archiveName)

  mkdirSync(tmpDir, { recursive: true })

  try {
    await download(url, archivePath)
    extractTarGz(archivePath, tmpDir)

    // rg archives extract to a directory named ripgrep-{version}-{target}/
    const extractedDir = join(tmpDir, `ripgrep-${RG_VERSION}-${rgTarget}`)
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

// ── Build bfs ────────────────────────────────────────────────────────────────

async function buildBfs() {
  if (!force && existsSync(bfsOutputPath)) {
    console.log(`✓ bfs already exists at ${bfsOutputPath}`)
    return
  }

  console.log(`⟳ Downloading and building bfs ${BFS_VERSION}...`)

  const archiveName = `bfs-${BFS_VERSION}.tar.gz`
  const url = `https://github.com/tavianator/bfs/releases/download/${BFS_VERSION}/${archiveName}`
  const tmpDir = join(tmpdir(), `yachiyo-bfs-${Date.now()}`)
  const archivePath = join(tmpDir, archiveName)

  mkdirSync(tmpDir, { recursive: true })

  try {
    await download(url, archivePath)

    // bfs tarball extracts flat (no parent directory), so extract into a dedicated subdirectory.
    const sourceDir = join(tmpDir, 'bfs-src')
    mkdirSync(sourceDir, { recursive: true })
    extractTarGz(archivePath, sourceDir)

    if (!existsSync(join(sourceDir, 'configure'))) {
      throw new Error(`bfs source not found at expected path: ${sourceDir}`)
    }

    console.log('  ⚙ ./configure --enable-release')
    run('./configure', ['--enable-release'], { cwd: sourceDir })

    console.log('  ⚙ make -j$(sysctl -n hw.ncpu)')
    const ncpu = execSync('sysctl -n hw.ncpu', { encoding: 'utf8' }).trim()
    run('make', [`-j${ncpu}`], { cwd: sourceDir })

    const bfsBinary = join(sourceDir, 'bin', 'bfs')
    if (!existsSync(bfsBinary)) {
      throw new Error(`bfs binary not found at expected path: ${bfsBinary}`)
    }

    mkdirSync(outputDir, { recursive: true })
    renameSync(bfsBinary, bfsOutputPath)
    chmodSync(bfsOutputPath, 0o755)

    console.log(`✓ bfs ${BFS_VERSION} → ${bfsOutputPath}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSearch binary setup (${platformDir})\n`)

  await downloadRipgrep()
  await buildBfs()

  console.log('\nDone.\n')
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`)
  process.exit(1)
})
