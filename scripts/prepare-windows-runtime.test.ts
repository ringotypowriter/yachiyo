import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import {
  buildPortablePostInstallInvocation,
  buildPython3Shim,
  prepareWindowsRuntime,
  validateWindowsRuntimeManifest
} from './prepare-windows-runtime.mjs'

const MANIFEST = {
  version: '2.51.0',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/PortableGit.7z.exe',
  sha256: 'a'.repeat(64),
  licenseUrl: 'https://github.com/git-for-windows/git/blob/main/COPYING',
  sourceUrl: 'https://github.com/git-for-windows/git'
}

test('Windows runtime manifest requires pinned version, URL, hash, license, and source', () => {
  assert.deepEqual(validateWindowsRuntimeManifest(MANIFEST), MANIFEST)

  for (const key of ['version', 'url', 'sha256', 'licenseUrl', 'sourceUrl'] as const) {
    const invalid = { ...MANIFEST, [key]: '' }
    assert.throws(() => validateWindowsRuntimeManifest(invalid), new RegExp(key, 'iu'))
  }

  assert.throws(
    () => validateWindowsRuntimeManifest({ ...MANIFEST, sha256: 'not-a-sha256' }),
    /sha256/iu
  )
  assert.throws(
    () => validateWindowsRuntimeManifest({ ...MANIFEST, url: 'latest' }),
    /pinned.*url/iu
  )
})

test('PortableGit post-install runs headlessly from the extracted runtime', () => {
  const runtimeDir = 'C:\\Temp & Cache\\PortableGit (Yachiyo)'

  assert.deepEqual(buildPortablePostInstallInvocation(runtimeDir), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'post-install.bat'],
    options: { cwd: runtimeDir, windowsHide: true }
  })
})

test('runtime preparation skips non-Windows targets without touching the runtime', async () => {
  let downloadCalls = 0

  assert.deepEqual(
    await prepareWindowsRuntime({
      platform: 'darwin',
      arch: 'arm64',
      manifest: MANIFEST,
      targetDir: '/tmp/yachiyo-unused-runtime',
      downloadArchive: async () => {
        downloadCalls++
      }
    }),
    { status: 'skipped', reason: 'unsupported-platform' }
  )
  assert.equal(downloadCalls, 0)
})

test('successful preparation initializes, inventories, atomically replaces, and then skips the same runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-portable-git-success-'))
  const targetDir = join(root, 'runtime')
  await mkdir(targetDir)
  await writeFile(join(targetDir, 'old-marker'), 'replace me')
  const postInstallDirs: string[] = []

  try {
    const result = await prepareWindowsRuntime({
      platform: 'win32',
      arch: 'x64',
      manifest: MANIFEST,
      targetDir,
      temporaryParentDir: root,
      downloadArchive: async (_url: string, destination: string) => {
        await writeFile(destination, 'archive')
      },
      calculateSha256: async () => MANIFEST.sha256,
      extractArchive: async (_archive: string, destination: string) => {
        for (const relativeDir of ['usr/bin', 'mingw64/bin', 'etc']) {
          await mkdir(join(destination, relativeDir), { recursive: true })
        }
        await writeFile(join(destination, 'usr', 'bin', 'bash.exe'), 'bash')
        await writeFile(join(destination, 'usr', 'bin', 'env.exe'), 'env')
        await writeFile(join(destination, 'usr', 'bin', 'msys-2.0.dll'), 'dll')
        await writeFile(join(destination, 'mingw64', 'bin', 'git.exe'), 'git')
        await writeFile(join(destination, 'LICENSE.txt'), 'upstream license')
        await writeFile(join(destination, 'post-install.bat'), '@echo off\r\n')
      },
      runPortablePostInstall: async (runtimeDir: string) => {
        postInstallDirs.push(runtimeDir)
      }
    })

    assert.deepEqual(result, { status: 'prepared', version: MANIFEST.version })
    assert.equal(postInstallDirs.length, 1)
    assert.equal(await readFile(join(targetDir, 'usr', 'bin', 'bash.exe'), 'utf8'), 'bash')
    assert.equal(
      await readFile(join(targetDir, 'licenses', 'PortableGit-LICENSE.txt'), 'utf8'),
      'upstream license'
    )
    await assert.rejects(() => readFile(join(targetDir, 'old-marker')), /ENOENT/u)
    assert.deepEqual(await readdir(root), ['runtime'])

    assert.deepEqual(
      await prepareWindowsRuntime({
        platform: 'win32',
        arch: 'x64',
        manifest: MANIFEST,
        targetDir,
        temporaryParentDir: root,
        downloadArchive: async () => assert.fail('current runtime must not download'),
        calculateSha256: async () => assert.fail('current runtime must not hash'),
        extractArchive: async () => assert.fail('current runtime must not extract'),
        runPortablePostInstall: async () => assert.fail('current runtime must not initialize')
      }),
      { status: 'current', version: MANIFEST.version }
    )

    await rm(join(targetDir, 'licenses', 'PortableGit-LICENSE.txt'))
    await assert.rejects(
      () =>
        prepareWindowsRuntime({
          platform: 'win32',
          arch: 'x64',
          manifest: MANIFEST,
          targetDir,
          temporaryParentDir: root,
          downloadArchive: async () => {
            throw new Error('missing license forces runtime refresh')
          }
        }),
      /missing license forces runtime refresh/u
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hash mismatch preserves the last valid runtime and removes temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-portable-git-red-'))
  const targetDir = join(root, 'runtime')
  await mkdir(targetDir)
  await writeFile(join(targetDir, 'valid-marker'), 'keep me')

  try {
    await assert.rejects(
      () =>
        prepareWindowsRuntime({
          platform: 'win32',
          arch: 'x64',
          manifest: MANIFEST,
          targetDir,
          temporaryParentDir: root,
          downloadArchive: async (_url: string, destination: string) => {
            await writeFile(destination, 'tampered archive')
          },
          calculateSha256: async () => 'b'.repeat(64),
          extractArchive: async () => assert.fail('must not extract a hash mismatch'),
          runPortablePostInstall: async () => assert.fail('must not initialize a hash mismatch')
        }),
      /SHA-256 mismatch/iu
    )

    assert.equal(await readFile(join(targetDir, 'valid-marker'), 'utf8'), 'keep me')
    assert.deepEqual(await readdir(root), ['runtime'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('partial extraction failure is cleaned without replacing the valid runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-portable-git-red-'))
  const targetDir = join(root, 'runtime')
  await mkdir(targetDir)
  await writeFile(join(targetDir, 'valid-marker'), 'keep me')

  try {
    await assert.rejects(
      () =>
        prepareWindowsRuntime({
          platform: 'win32',
          arch: 'x64',
          manifest: MANIFEST,
          targetDir,
          temporaryParentDir: root,
          downloadArchive: async (_url: string, destination: string) => {
            await writeFile(destination, 'archive')
          },
          calculateSha256: async () => MANIFEST.sha256,
          extractArchive: async (_archive: string, destination: string) => {
            await mkdir(join(destination, 'usr', 'bin'), { recursive: true })
            await writeFile(join(destination, 'usr', 'bin', 'bash.exe'), 'partial')
            throw new Error('extractor stopped')
          },
          runPortablePostInstall: async () => assert.fail('must not initialize partial output')
        }),
      /extractor stopped/iu
    )

    assert.equal(await readFile(join(targetDir, 'valid-marker'), 'utf8'), 'keep me')
    assert.deepEqual(await readdir(root), ['runtime'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

test('python3 shim prefers py.exe -3, falls back to python.exe, then fails explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-python3-shim-'))
  const shimPath = join(root, 'python3')
  const pyPath = join(root, 'py.exe')
  const pythonPath = join(root, 'python.exe')
  await writeExecutable(shimPath, buildPython3Shim())
  await writeExecutable(
    pyPath,
    '#!/bin/sh\nprintf "py-count:%s\\n" "$#"\nfor arg in "$@"; do printf "<%s>\\n" "$arg"; done\n'
  )
  await writeExecutable(
    pythonPath,
    '#!/bin/sh\nprintf "python-count:%s\\n" "$#"\nfor arg in "$@"; do printf "<%s>\\n" "$arg"; done\n'
  )

  try {
    const env = { PATH: root }
    const preferred = spawnSync('/bin/bash', [shimPath, 'alpha', 'two words'], {
      encoding: 'utf8',
      env
    })
    assert.equal(preferred.status, 0)
    assert.equal(preferred.stdout, 'py-count:3\n<-3>\n<alpha>\n<two words>\n')

    await writeExecutable(pyPath, '#!/bin/sh\nexit 1\n')
    const aliasFallback = spawnSync('/bin/bash', [shimPath, 'alpha', 'two words'], {
      encoding: 'utf8',
      env
    })
    assert.equal(aliasFallback.status, 0)
    assert.equal(aliasFallback.stdout, 'python-count:2\n<alpha>\n<two words>\n')

    await rm(pyPath)
    const fallback = spawnSync('/bin/bash', [shimPath, 'alpha', 'two words'], {
      encoding: 'utf8',
      env
    })
    assert.equal(fallback.status, 0)
    assert.equal(fallback.stdout, 'python-count:2\n<alpha>\n<two words>\n')

    await rm(pythonPath)
    const missing = spawnSync('/bin/bash', [shimPath], { encoding: 'utf8', env })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /Python 3.*python\.org/iu)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
