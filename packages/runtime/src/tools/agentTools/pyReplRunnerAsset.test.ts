import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { stagePythonRunner } from '../../services/python/managedPythonRuntime.ts'

interface RunnerFixture {
  directory: string
  rootPath: string
  cleanup(): Promise<void>
}

async function createRunnerFixture(name: string): Promise<RunnerFixture> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), `yachiyo-runner-${name}-`))
  const directory = await realpath(temporaryDirectory)
  const rootPath = join(directory, 'home', 'python')
  await mkdir(rootPath, { recursive: true })
  return {
    directory,
    rootPath,
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

test('stages the adjacent source runner under its verified content hash', async () => {
  const fixture = await createRunnerFixture('adjacent')
  const source = new URL('./pyReplRunner.py', import.meta.url)
  try {
    const sourceBytes = await readFile(source)
    const targetPath = await stagePythonRunner(source, fixture.rootPath)

    assert.equal(basename(targetPath), `${sha256(sourceBytes)}.py`)
    assert.deepEqual(await readFile(targetPath), sourceBytes)
    assert.equal(await realpath(targetPath), targetPath)
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(fixture.rootPath, 'runners'))).mode & 0o777, 0o700)
      assert.equal((await stat(targetPath)).mode & 0o777, 0o600)
    }
  } finally {
    await fixture.cleanup()
  }
})

test('stages through an alternate spelling of the verified parent path', async () => {
  const fixture = await createRunnerFixture('parent-alias')
  const canonicalHomePath = join(fixture.directory, 'home')
  const aliasHomePath = join(fixture.directory, 'home-alias')
  const sourcePath = join(fixture.directory, 'runner.py')
  await symlink(canonicalHomePath, aliasHomePath, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(sourcePath, 'print(1)\n')
  try {
    const targetPath = await stagePythonRunner(sourcePath, join(aliasHomePath, 'python'))
    const canonicalRootPath = await realpath(fixture.rootPath)

    assert.equal(targetPath.startsWith(join(canonicalRootPath, 'runners')), true)
    assert.equal(await realpath(targetPath), targetPath)
  } finally {
    await fixture.cleanup()
  }
})

test('stages injected packaged runner assets from ordinary and asar-shaped paths', async (t) => {
  const sourceShapes = [
    ['ordinary', 'resources', 'pyReplRunner.py'],
    ['asar', 'app.asar.unpacked', 'packages', 'runtime', 'pyReplRunner.py']
  ] as const

  for (const [name, ...parts] of sourceShapes) {
    await t.test(name, async () => {
      const fixture = await createRunnerFixture(name)
      const sourcePath = join(fixture.directory, ...parts)
      const sourceBytes = Buffer.from(`print(${JSON.stringify(name)})\n`)
      await mkdir(join(sourcePath, '..'), { recursive: true })
      await writeFile(sourcePath, sourceBytes)
      try {
        const source = name === 'asar' ? pathToFileURL(sourcePath) : sourcePath
        const targetPath = await stagePythonRunner(source, fixture.rootPath)
        assert.deepEqual(await readFile(targetPath), sourceBytes)
      } finally {
        await fixture.cleanup()
      }
    })
  }
})

test('reuses a verified runner target without replacing its inode and normalizes its mode', async () => {
  const fixture = await createRunnerFixture('reuse')
  const sourcePath = join(fixture.directory, 'runner.py')
  await writeFile(sourcePath, 'print(1)\n')
  try {
    const firstPath = await stagePythonRunner(sourcePath, fixture.rootPath)
    const firstIdentity = await lstat(firstPath)
    if (process.platform !== 'win32') await chmod(firstPath, 0o744)

    const secondPath = await stagePythonRunner(sourcePath, fixture.rootPath)
    const secondIdentity = await lstat(secondPath)
    assert.equal(secondPath, firstPath)
    assert.equal(secondIdentity.dev, firstIdentity.dev)
    assert.equal(secondIdentity.ino, firstIdentity.ino)
    if (process.platform !== 'win32') assert.equal(secondIdentity.mode & 0o777, 0o600)
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent staging publishes one verified runner without temporary-file leaks', async () => {
  const fixture = await createRunnerFixture('concurrent')
  const sourcePath = join(fixture.directory, 'runner.py')
  const sourceBytes = Buffer.from('print(42)\n')
  await writeFile(sourcePath, sourceBytes)
  try {
    const targets = await Promise.all(
      Array.from({ length: 12 }, () => stagePythonRunner(sourcePath, fixture.rootPath))
    )
    assert.equal(new Set(targets).size, 1)
    assert.deepEqual(await readFile(targets[0]), sourceBytes)
    assert.deepEqual(await readdir(join(fixture.rootPath, 'runners')), [basename(targets[0])])
  } finally {
    await fixture.cleanup()
  }
})

test('fails closed and preserves a tampered content-addressed runner target', async () => {
  const fixture = await createRunnerFixture('tampered')
  const sourcePath = join(fixture.directory, 'runner.py')
  await writeFile(sourcePath, 'print(7)\n')
  try {
    const targetPath = await stagePythonRunner(sourcePath, fixture.rootPath)
    await writeFile(targetPath, 'tampered\n')

    await assert.rejects(
      stagePythonRunner(sourcePath, fixture.rootPath),
      /target is present but failed verification/u
    )
    assert.equal(await readFile(targetPath, 'utf8'), 'tampered\n')
    assert.deepEqual(await readdir(join(fixture.rootPath, 'runners')), [basename(targetPath)])
  } finally {
    await fixture.cleanup()
  }
})
