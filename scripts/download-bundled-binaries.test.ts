import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { resolveBundledBinaryAssets, stageBundledBinary } from './bundled-binary-assets.mjs'

test('Windows x64 bundled assets are pinned, hashed, and extract .exe entries', () => {
  const assets = resolveBundledBinaryAssets('win32', 'x64')

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

test('macOS bundled asset mapping remains available', () => {
  const assets = resolveBundledBinaryAssets('darwin', 'arm64')

  assert.deepEqual(
    assets.map((asset: { outputName: string }) => asset.outputName),
    ['rg', 'fd']
  )
})

test('bundled binary hash mismatch preserves the installed binary and cleans temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-binary-hash-'))
  const outputDir = join(root, 'output')
  const asset = resolveBundledBinaryAssets('win32', 'x64')[0]
  await mkdir(outputDir)
  await writeFile(join(outputDir, asset.outputName), 'known-good')

  try {
    await assert.rejects(
      () =>
        stageBundledBinary({
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

test('bundled binary staging validates the pinned archive entry before replacing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-binary-entry-'))
  const outputDir = join(root, 'output')
  const asset = resolveBundledBinaryAssets('win32', 'x64')[1]
  await mkdir(outputDir)
  await writeFile(join(outputDir, asset.outputName), 'known-good')

  try {
    await assert.rejects(
      () =>
        stageBundledBinary({
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

test('verified bundled binary staging installs the pinned entry and cleans temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-binary-success-'))
  const outputDir = join(root, 'output')
  const asset = resolveBundledBinaryAssets('win32', 'x64')[0]

  try {
    assert.deepEqual(
      await stageBundledBinary({
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

test('uv is not part of any bundled binary target', () => {
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64']
  ]) {
    assert.equal(
      resolveBundledBinaryAssets(platform, arch).some(
        (candidate: { name: string }) => candidate.name === 'uv'
      ),
      false,
      `${platform}/${arch}`
    )
  }
})

test('unsupported targets stay empty and unpinned asset URLs are rejected without PATH fallback', async () => {
  assert.deepEqual(resolveBundledBinaryAssets('freebsd', 'x64'), [])
  assert.deepEqual(resolveBundledBinaryAssets('darwin', 'riscv64'), [])

  const root = await mkdtemp(join(tmpdir(), 'yachiyo-binary-unpinned-'))
  const pinned = resolveBundledBinaryAssets('darwin', 'arm64')[0]
  for (const url of [
    'https://github.com/example/tool/releases/latest/download/tool.tar.gz',
    'https://example.com/tool.tar.gz'
  ]) {
    await assert.rejects(
      stageBundledBinary({
        asset: { ...pinned, url },
        outputDir: join(root, 'output'),
        downloadArchive: async () => assert.fail('invalid asset must not download')
      }),
      /pinned GitHub URL/u
    )
  }
  assert.deepEqual(await readdir(root), [])
  await rm(root, { recursive: true, force: true })
})

test('staging atomically publishes executable and exact sidecar, reuses verified files, and redownloads tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-binary-attestation-'))
  const outputDir = join(root, 'output')
  const asset = resolveBundledBinaryAssets('darwin', 'arm64').find(
    (candidate: { name: string }) => candidate.name === 'rg'
  )
  assert.ok(asset)
  let binaryBytes = Buffer.from('first verified rg binary')
  let downloadCount = 0

  const calculateSha256 = async (path: string): Promise<string> => {
    if (path.endsWith('asset.archive')) return asset.sha256
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  }
  const downloadArchive = async (_url: string, destination: string): Promise<void> => {
    downloadCount += 1
    await writeFile(destination, 'archive')
  }
  const extractArchive = async (_archive: string, destination: string): Promise<void> => {
    const source = join(destination, ...asset.archiveEntry.split('/'))
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, binaryBytes)
  }
  const stage = (force = false): ReturnType<typeof stageBundledBinary> =>
    stageBundledBinary({
      asset,
      outputDir,
      temporaryParentDir: root,
      force,
      calculateSha256,
      downloadArchive,
      extractArchive
    })

  try {
    const outputPath = join(outputDir, asset.outputName)
    const attestationPath = `${outputPath}.asset.json`
    assert.deepEqual(await stage(true), { status: 'downloaded', outputPath })
    const expectedAttestation = {
      name: asset.name,
      version: asset.version,
      platform: asset.platform,
      arch: asset.arch,
      targetTriple: asset.targetTriple,
      archiveSha256: asset.sha256,
      outputSha256: createHash('sha256').update(binaryBytes).digest('hex')
    }
    assert.deepEqual(JSON.parse(await readFile(attestationPath, 'utf8')), expectedAttestation)
    assert.equal(
      await readFile(attestationPath, 'utf8'),
      `${JSON.stringify(expectedAttestation, null, 2)}\n`
    )
    assert.deepEqual(await readdir(outputDir), [asset.outputName, `${asset.outputName}.asset.json`])
    if (process.platform !== 'win32') {
      assert.equal((await stat(outputPath)).mode & 0o777, 0o755)
      assert.equal((await stat(attestationPath)).mode & 0o777, 0o644)
    }

    const firstDownloadCount = downloadCount
    assert.deepEqual(await stage(), { status: 'current', outputPath })
    assert.equal(downloadCount, firstDownloadCount)

    await writeFile(outputPath, 'tampered executable')
    if (process.platform !== 'win32') await chmod(outputPath, 0o755)
    binaryBytes = Buffer.from('second verified rg binary')
    assert.deepEqual(await stage(), { status: 'downloaded', outputPath })
    assert.equal(downloadCount, firstDownloadCount + 1)
    assert.deepEqual(await readFile(outputPath), binaryBytes)

    await writeFile(
      attestationPath,
      JSON.stringify({ ...expectedAttestation, outputSha256: '0'.repeat(64), extra: true })
    )
    if (process.platform !== 'win32') await chmod(attestationPath, 0o644)
    binaryBytes = Buffer.from('third verified rg binary')
    assert.deepEqual(await stage(), { status: 'downloaded', outputPath })
    assert.equal(downloadCount, firstDownloadCount + 2)
    assert.deepEqual(await readFile(outputPath), binaryBytes)
    assert.deepEqual(await readdir(root), ['output'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
