import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { resolveSearchBinaryAssets, stageSearchBinary } from './search-binary-assets.mjs'

test('Windows x64 search assets are pinned, hashed, and extract .exe entries', () => {
  const assets = resolveSearchBinaryAssets('win32', 'x64')

  assert.deepEqual(
    assets.map((asset: { name: string; outputName: string }) => ({
      name: asset.name,
      outputName: asset.outputName
    })),
    [
      { name: 'rg', outputName: 'rg.exe' },
      { name: 'fd', outputName: 'fd.exe' }
    ]
  )
  for (const asset of assets) {
    assert.match(asset.version, /^\d+\.\d+\.\d+$/u)
    assert.match(asset.url, /^https:\/\/github\.com\//u)
    assert.match(asset.sha256, /^[a-f0-9]{64}$/u)
    assert.match(asset.archiveEntry, /\.exe$/iu)
    assert.doesNotMatch(asset.url, /latest/iu)
  }
})

test('macOS search asset mapping remains available', () => {
  const assets = resolveSearchBinaryAssets('darwin', 'arm64')

  assert.deepEqual(
    assets.map((asset: { outputName: string }) => asset.outputName),
    ['rg', 'fd']
  )
})

test('search binary hash mismatch preserves the installed binary and cleans temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-search-hash-'))
  const outputDir = join(root, 'output')
  const asset = resolveSearchBinaryAssets('win32', 'x64')[0]
  await mkdir(outputDir)
  await writeFile(join(outputDir, asset.outputName), 'known-good')

  try {
    await assert.rejects(
      () =>
        stageSearchBinary({
          asset,
          outputDir,
          temporaryParentDir: root,
          force: true,
          downloadArchive: async (_url: string, destination: string) => {
            await writeFile(destination, 'tampered')
          },
          calculateSha256: async () => '0'.repeat(64),
          extractArchive: async () => assert.fail('hash mismatch must not be extracted')
        }),
      /SHA-256 mismatch/iu
    )

    assert.equal(await readFile(join(outputDir, asset.outputName), 'utf8'), 'known-good')
    assert.deepEqual(await readdir(root), ['output'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search binary staging validates the pinned archive entry before replacing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-search-entry-'))
  const outputDir = join(root, 'output')
  const asset = resolveSearchBinaryAssets('win32', 'x64')[1]
  await mkdir(outputDir)
  await writeFile(join(outputDir, asset.outputName), 'known-good')

  try {
    await assert.rejects(
      () =>
        stageSearchBinary({
          asset,
          outputDir,
          temporaryParentDir: root,
          force: true,
          downloadArchive: async (_url: string, destination: string) => {
            await writeFile(destination, 'archive')
          },
          calculateSha256: async () => asset.sha256,
          extractArchive: async (_archive: string, destination: string) => {
            await writeFile(join(destination, 'unexpected.exe'), 'wrong entry')
          }
        }),
      /archive entry/iu
    )

    assert.equal(await readFile(join(outputDir, asset.outputName), 'utf8'), 'known-good')
    assert.deepEqual(await readdir(root), ['output'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified search binary staging installs the pinned entry and cleans temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-search-success-'))
  const outputDir = join(root, 'output')
  const asset = resolveSearchBinaryAssets('win32', 'x64')[0]

  try {
    assert.deepEqual(
      await stageSearchBinary({
        asset,
        outputDir,
        temporaryParentDir: root,
        force: true,
        downloadArchive: async (_url: string, destination: string) => {
          await writeFile(destination, 'archive')
        },
        calculateSha256: async () => asset.sha256,
        extractArchive: async (_archive: string, destination: string) => {
          const source = join(destination, ...asset.archiveEntry.split('/'))
          await mkdir(dirname(source), { recursive: true })
          await writeFile(source, 'verified binary')
        }
      }),
      { status: 'downloaded', outputPath: join(outputDir, asset.outputName) }
    )

    assert.equal(await readFile(join(outputDir, asset.outputName), 'utf8'), 'verified binary')
    assert.deepEqual(await readdir(root), ['output'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
