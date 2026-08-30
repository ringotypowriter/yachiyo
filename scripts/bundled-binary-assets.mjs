/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const manifestPath = resolve(import.meta.dirname, 'bundled-binary-assets.json')

function validateAsset(asset) {
  for (const field of [
    'platform',
    'arch',
    'targetTriple',
    'name',
    'version',
    'url',
    'sha256',
    'archiveEntry',
    'outputName'
  ]) {
    if (typeof asset?.[field] !== 'string' || !asset[field].trim()) {
      throw new Error(`Bundled binary asset is missing ${field}.`)
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    throw new Error(`Bundled binary ${asset.name} has an invalid sha256.`)
  }
  if (!/^https:\/\/github\.com\//u.test(asset.url) || /latest/iu.test(asset.url)) {
    throw new Error(`Bundled binary ${asset.name} must use a pinned GitHub URL.`)
  }
  const parts = asset.archiveEntry.split('/')
  if (
    asset.archiveEntry.includes('\\') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Bundled binary ${asset.name} has an unsafe archive entry.`)
  }
  if (
    asset.outputName !== basename(asset.outputName) ||
    asset.outputName.includes('/') ||
    asset.outputName.includes('\\')
  ) {
    throw new Error(`Bundled binary ${asset.name} has an unsafe output name.`)
  }
  return asset
}

function readManifest() {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(parsed.assets)) throw new Error('Bundled binary asset manifest is invalid.')
  return parsed.assets.map(validateAsset)
}

const assets = readManifest()

export function resolveBundledBinaryAssets(platform, arch) {
  return assets.filter((asset) => asset.platform === platform && asset.arch === arch)
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

const ATTESTATION_FIELDS = [
  'name',
  'version',
  'platform',
  'arch',
  'targetTriple',
  'archiveSha256',
  'outputSha256'
]

function createAttestation(asset, outputSha256) {
  return {
    name: asset.name,
    version: asset.version,
    platform: asset.platform,
    arch: asset.arch,
    targetTriple: asset.targetTriple,
    archiveSha256: asset.sha256.toLowerCase(),
    outputSha256: outputSha256.toLowerCase()
  }
}

async function isCurrentAsset(asset, outputPath, attestationPath, calculateSha256) {
  try {
    const [outputStats, attestationStats] = await Promise.all([
      lstat(outputPath),
      lstat(attestationPath)
    ])
    if (
      !outputStats.isFile() ||
      outputStats.isSymbolicLink() ||
      !attestationStats.isFile() ||
      attestationStats.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((outputStats.mode & 0o777) !== 0o755 || (attestationStats.mode & 0o777) !== 0o644))
    ) {
      return false
    }

    const attestation = JSON.parse(await readFile(attestationPath, 'utf8'))
    if (
      !attestation ||
      typeof attestation !== 'object' ||
      Array.isArray(attestation) ||
      Object.keys(attestation).length !== ATTESTATION_FIELDS.length ||
      !ATTESTATION_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(attestation, field))
    ) {
      return false
    }

    const expected = createAttestation(asset, attestation.outputSha256)
    if (
      !/^[a-f0-9]{64}$/u.test(attestation.outputSha256) ||
      !ATTESTATION_FIELDS.every((field) => attestation[field] === expected[field])
    ) {
      return false
    }

    const actualOutputSha256 = await calculateSha256(outputPath)
    return actualOutputSha256.toLowerCase() === attestation.outputSha256
  } catch {
    return false
  }
}

async function defaultExtractArchive(archivePath, destination) {
  await mkdir(destination, { recursive: true })
  const result = spawnSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xf', archivePath, '-C', destination],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Could not extract ${basename(archivePath)}.`)
  }
}

async function replaceFile(source, outputPath, executable) {
  const outputDir = dirname(outputPath)
  const stagedPath = join(outputDir, `.${basename(outputPath)}.${randomUUID()}.tmp`)
  const backupPath = join(outputDir, `.${basename(outputPath)}.${randomUUID()}.backup`)
  await copyFile(source, stagedPath)
  if (process.platform !== 'win32') await chmod(stagedPath, executable ? 0o755 : 0o644)

  try {
    await rename(stagedPath, outputPath)
  } catch (error) {
    try {
      await lstat(outputPath)
    } catch {
      throw error
    }
    await rename(outputPath, backupPath)
    try {
      await rename(stagedPath, outputPath)
      await rm(backupPath, { recursive: true, force: true })
    } catch (replaceError) {
      try {
        await lstat(outputPath)
      } catch {
        await rename(backupPath, outputPath)
      }
      throw replaceError
    }
  } finally {
    await rm(stagedPath, { recursive: true, force: true })
    await rm(backupPath, { recursive: true, force: true })
  }
}

async function resolveExtractedBinary(extractedDir, archiveEntry) {
  const parts = archiveEntry.split('/')
  let currentPath = extractedDir
  for (let index = 0; index < parts.length; index += 1) {
    currentPath = join(currentPath, parts[index])
    let stats
    try {
      stats = await lstat(currentPath)
    } catch (error) {
      throw new Error(`Pinned archive entry was not found: ${archiveEntry}`, { cause: error })
    }
    if (
      stats.isSymbolicLink() ||
      (index < parts.length - 1 && !stats.isDirectory()) ||
      (index === parts.length - 1 && !stats.isFile())
    ) {
      throw new Error(`Pinned archive entry is unsafe: ${archiveEntry}`)
    }
  }
  return currentPath
}

export async function stageBundledBinary(input) {
  const asset = validateAsset(input.asset)
  const outputPath = join(input.outputDir, asset.outputName)
  const attestationPath = `${outputPath}.asset.json`
  const calculateSha256 = input.calculateSha256 ?? defaultCalculateSha256
  if (!input.force && (await isCurrentAsset(asset, outputPath, attestationPath, calculateSha256))) {
    return { status: 'current', outputPath }
  }

  const temporaryParentDir = input.temporaryParentDir ?? tmpdir()
  await mkdir(temporaryParentDir, { recursive: true })
  const temporaryDir = await mkdtemp(join(temporaryParentDir, '.yachiyo-binary-'))
  const archivePath = join(temporaryDir, 'asset.archive')
  const extractedDir = join(temporaryDir, 'extracted')
  const attestationSource = join(temporaryDir, 'asset.json')

  try {
    await (input.downloadArchive ?? defaultDownloadArchive)(asset.url, archivePath)
    const actualHash = await calculateSha256(archivePath)
    if (actualHash.toLowerCase() !== asset.sha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actualHash}.`
      )
    }

    await mkdir(extractedDir, { recursive: true })
    await (input.extractArchive ?? defaultExtractArchive)(archivePath, extractedDir)
    const extractedBinary = await resolveExtractedBinary(extractedDir, asset.archiveEntry)
    const outputSha256 = await calculateSha256(extractedBinary)
    await writeFile(
      attestationSource,
      `${JSON.stringify(createAttestation(asset, outputSha256), null, 2)}\n`
    )

    await mkdir(input.outputDir, { recursive: true })
    await replaceFile(extractedBinary, outputPath, true)
    await replaceFile(attestationSource, attestationPath, false)
    return { status: 'downloaded', outputPath }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}
