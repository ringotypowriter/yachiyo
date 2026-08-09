/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const manifestPath = resolve(import.meta.dirname, 'search-binary-assets.json')

function validateAsset(asset) {
  for (const field of [
    'platform',
    'arch',
    'name',
    'version',
    'url',
    'sha256',
    'archiveEntry',
    'outputName'
  ]) {
    if (typeof asset?.[field] !== 'string' || !asset[field].trim()) {
      throw new Error(`Search binary asset is missing ${field}.`)
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    throw new Error(`Search binary ${asset.name} has an invalid sha256.`)
  }
  if (!/^https:\/\/github\.com\//u.test(asset.url) || /latest/iu.test(asset.url)) {
    throw new Error(`Search binary ${asset.name} must use a pinned GitHub URL.`)
  }
  const parts = asset.archiveEntry.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Search binary ${asset.name} has an unsafe archive entry.`)
  }
  return asset
}

function readManifest() {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(parsed.assets)) throw new Error('Search binary asset manifest is invalid.')
  return parsed.assets.map(validateAsset)
}

const assets = readManifest()

export function resolveSearchBinaryAssets(platform, arch) {
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

async function replaceFile(source, outputPath) {
  const outputDir = dirname(outputPath)
  const stagedPath = join(outputDir, `.${basename(outputPath)}.${randomUUID()}.tmp`)
  const backupPath = join(outputDir, `.${basename(outputPath)}.${randomUUID()}.backup`)
  await copyFile(source, stagedPath)
  if (!outputPath.toLowerCase().endsWith('.exe')) await chmod(stagedPath, 0o755)

  try {
    await rename(stagedPath, outputPath)
  } catch (error) {
    if (!existsSync(outputPath)) throw error
    await rename(outputPath, backupPath)
    try {
      await rename(stagedPath, outputPath)
      await rm(backupPath, { force: true })
    } catch (replaceError) {
      if (existsSync(backupPath) && !existsSync(outputPath)) {
        await rename(backupPath, outputPath)
      }
      throw replaceError
    }
  } finally {
    await rm(stagedPath, { force: true })
    await rm(backupPath, { force: true })
  }
}

export async function stageSearchBinary(input) {
  const asset = validateAsset(input.asset)
  const outputPath = join(input.outputDir, asset.outputName)
  if (!input.force && existsSync(outputPath)) {
    return { status: 'current', outputPath }
  }

  const temporaryParentDir = input.temporaryParentDir ?? tmpdir()
  await mkdir(temporaryParentDir, { recursive: true })
  const temporaryDir = await mkdtemp(join(temporaryParentDir, '.yachiyo-search-'))
  const archivePath = join(temporaryDir, 'asset.archive')
  const extractedDir = join(temporaryDir, 'extracted')

  try {
    await (input.downloadArchive ?? defaultDownloadArchive)(asset.url, archivePath)
    const actualHash = await (input.calculateSha256 ?? defaultCalculateSha256)(archivePath)
    if (actualHash.toLowerCase() !== asset.sha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actualHash}.`
      )
    }

    await mkdir(extractedDir, { recursive: true })
    await (input.extractArchive ?? defaultExtractArchive)(archivePath, extractedDir)
    const extractedBinary = join(extractedDir, ...asset.archiveEntry.split('/'))
    if (!existsSync(extractedBinary)) {
      throw new Error(`Pinned archive entry was not found: ${asset.archiveEntry}`)
    }

    await mkdir(input.outputDir, { recursive: true })
    await replaceFile(extractedBinary, outputPath)
    return { status: 'downloaded', outputPath }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}
