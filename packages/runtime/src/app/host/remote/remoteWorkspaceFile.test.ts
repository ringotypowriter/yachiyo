import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { readRemoteWorkspaceFile, MAX_REMOTE_FILE_BYTES } from './remoteWorkspaceFile.ts'

test('remote Markdown files resolve relative, absolute and encoded file URLs within workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-file-'))
  try {
    const file = join(root, 'image space.png')
    await writeFile(file, 'image bytes')
    for (const path of ['image%20space.png', file, pathToFileURL(file).href]) {
      const result = await readRemoteWorkspaceFile(root, path)
      assert.equal(result.filename, 'image space.png')
      assert.equal(Buffer.from(result.data, 'base64').toString(), 'image bytes')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote Markdown files reject traversal, outside absolute paths, symlink escape and URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-file-'))
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const secret = join(root, 'secret.txt')
    await writeFile(secret, 'secret')
    await symlink(secret, join(workspace, 'escape.txt'))
    for (const path of [
      '../secret.txt',
      '%2E%2E/secret.txt',
      secret,
      pathToFileURL(secret).href,
      'escape.txt',
      'https://example.com/image.png',
      'file://other/secret.txt'
    ]) {
      await assert.rejects(readRemoteWorkspaceFile(workspace, path))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote Markdown files reject directories and oversized payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-file-'))
  try {
    await writeFile(join(root, 'large.bin'), Buffer.alloc(MAX_REMOTE_FILE_BYTES + 1))
    await assert.rejects(readRemoteWorkspaceFile(root, '.'))
    await assert.rejects(readRemoteWorkspaceFile(root, 'large.bin'), /too large/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
