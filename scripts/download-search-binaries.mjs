#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import process from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveSearchBinaryAssets, stageSearchBinary } from './search-binary-assets.mjs'

const EB_OS_MAP = { darwin: 'mac', linux: 'linux', win32: 'win' }

async function main() {
  const assets = resolveSearchBinaryAssets(process.platform, process.arch)
  if (assets.length === 0) {
    console.log(
      `Skipping search binary download for unsupported target ${process.platform}/${process.arch}.`
    )
    return
  }

  const repoRoot = resolve(import.meta.dirname, '..')
  const platformDir = `${EB_OS_MAP[process.platform] ?? process.platform}-${process.arch}`
  const outputDir = resolve(repoRoot, 'apps', 'desktop', 'resources', 'bin', platformDir)
  const force = process.argv.includes('--force')

  for (const asset of assets) {
    const result = await stageSearchBinary({ asset, outputDir, force })
    console.log(`✓ ${asset.name} ${asset.version} (${result.status}) → ${result.outputPath}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
