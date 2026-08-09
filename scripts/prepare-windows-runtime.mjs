#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const RUNTIME_MARKER = '.yachiyo-runtime.json'

export function validateWindowsRuntimeManifest(manifest) {
  for (const field of ['version', 'url', 'sha256', 'licenseUrl', 'sourceUrl']) {
    if (typeof manifest?.[field] !== 'string' || !manifest[field].trim()) {
      throw new Error(`Windows runtime manifest is missing ${field}.`)
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    throw new Error('Windows runtime manifest sha256 must be 64 lowercase hexadecimal characters.')
  }
  if (!/^https:\/\/github\.com\//u.test(manifest.url) || /latest/iu.test(manifest.url)) {
    throw new Error('Windows runtime manifest must use a pinned GitHub asset URL.')
  }
  return manifest
}

export function buildPython3Shim() {
  return [
    '#!/usr/bin/env bash',
    "probe='import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)'",
    'if command -v py.exe >/dev/null 2>&1 && py.exe -3 -c "$probe" >/dev/null 2>&1; then',
    '  exec py.exe -3 "$@"',
    'fi',
    'if command -v python.exe >/dev/null 2>&1 && python.exe -c "$probe" >/dev/null 2>&1; then',
    '  exec python.exe "$@"',
    'fi',
    'echo "Python 3 is required. Install it from https://www.python.org/downloads/windows/." >&2',
    'exit 127',
    ''
  ].join('\n')
}

const REQUIRED_RUNTIME_PATHS = [
  ['usr', 'bin', 'bash.exe'],
  ['usr', 'bin', 'env.exe'],
  ['usr', 'bin', 'msys-2.0.dll'],
  ['mingw64', 'bin', 'git.exe'],
  ['etc'],
  ['licenses', 'PortableGit-LICENSE.txt']
]

function runtimeIsComplete(runtimeDir) {
  return REQUIRED_RUNTIME_PATHS.every((parts) => existsSync(join(runtimeDir, ...parts)))
}

async function runtimeIsCurrent(runtimeDir, manifest) {
  if (!runtimeIsComplete(runtimeDir)) return false
  try {
    const marker = JSON.parse(await readFile(join(runtimeDir, RUNTIME_MARKER), 'utf8'))
    return marker.version === manifest.version && marker.sha256 === manifest.sha256
  } catch {
    return false
  }
}

async function defaultDownloadArchive(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} fetching ${url}`)
  }
  await pipeline(response.body, createWriteStream(destination))
}

async function defaultCalculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function defaultExtractArchive(archivePath, destination) {
  await mkdir(destination, { recursive: true })
  // PortableGit's self-extractor runs and removes post-install.bat before it exits.
  const result = spawnSync(archivePath, ['-y', `-o${destination}`], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'PortableGit extraction failed.')
  }
}

async function preservePortableGitLicense(runtimeDir) {
  const candidates = [
    join(runtimeDir, 'LICENSE.txt'),
    join(runtimeDir, 'COPYING'),
    join(runtimeDir, 'mingw64', 'share', 'licenses', 'git', 'COPYING')
  ]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) throw new Error('PortableGit upstream license file is missing.')
  const licenseDir = join(runtimeDir, 'licenses')
  await mkdir(licenseDir, { recursive: true })
  await copyFile(source, join(licenseDir, 'PortableGit-LICENSE.txt'))
}

async function replaceDirectory(sourceDir, targetDir) {
  const backupDir = join(dirname(targetDir), `.${basename(targetDir)}.${randomUUID()}.backup`)
  const hadTarget = existsSync(targetDir)
  if (hadTarget) await rename(targetDir, backupDir)

  try {
    await rename(sourceDir, targetDir)
    await rm(backupDir, { recursive: true, force: true })
  } catch (error) {
    if (hadTarget && existsSync(backupDir) && !existsSync(targetDir)) {
      await rename(backupDir, targetDir)
    }
    throw error
  }
}

async function writePython3Shim(path) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buildPython3Shim(), 'utf8')
  await chmod(path, 0o755)
}

export async function prepareWindowsRuntime(input) {
  if (input.platform !== 'win32' || input.arch !== 'x64') {
    return { status: 'skipped', reason: 'unsupported-platform' }
  }

  const manifest = validateWindowsRuntimeManifest(input.manifest)
  if (await runtimeIsCurrent(input.targetDir, manifest)) {
    await writePython3Shim(input.python3ShimPath)
    return { status: 'current', version: manifest.version }
  }

  const temporaryParentDir = input.temporaryParentDir ?? dirname(input.targetDir)
  await mkdir(temporaryParentDir, { recursive: true })
  const temporaryDir = await mkdtemp(join(temporaryParentDir, '.yachiyo-portable-git-'))
  const archivePath = join(temporaryDir, manifest.assetName ?? 'PortableGit.7z.exe')
  const extractedDir = join(temporaryDir, 'runtime')

  try {
    await (input.downloadArchive ?? defaultDownloadArchive)(manifest.url, archivePath)
    const actualHash = await (input.calculateSha256 ?? defaultCalculateSha256)(archivePath)
    if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for PortableGit: expected ${manifest.sha256}, got ${actualHash}.`
      )
    }

    await mkdir(extractedDir, { recursive: true })
    await (input.extractArchive ?? defaultExtractArchive)(archivePath, extractedDir)
    await preservePortableGitLicense(extractedDir)
    if (!runtimeIsComplete(extractedDir)) {
      throw new Error('PortableGit runtime inventory is incomplete after extraction and setup.')
    }
    await writeFile(
      join(extractedDir, RUNTIME_MARKER),
      `${JSON.stringify({ version: manifest.version, sha256: manifest.sha256 }, null, 2)}\n`,
      'utf8'
    )
    await replaceDirectory(extractedDir, input.targetDir)
    await writePython3Shim(input.python3ShimPath)
    return { status: 'prepared', version: manifest.version }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

async function main() {
  const repoRoot = resolve(import.meta.dirname, '..')
  const manifest = JSON.parse(
    await readFile(resolve(repoRoot, 'scripts', 'windows-runtime.json'), 'utf8')
  )
  const helperBinDir = resolve(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'win-x64')
  const result = await prepareWindowsRuntime({
    platform: process.platform,
    arch: process.arch,
    manifest,
    targetDir: join(helperBinDir, 'bash'),
    temporaryParentDir: helperBinDir,
    python3ShimPath: join(helperBinDir, 'python3')
  })
  console.log(`Windows runtime: ${result.status}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
